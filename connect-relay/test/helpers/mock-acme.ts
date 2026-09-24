/**
 * A small RFC 8555 ACME server for tests. It checks what a real CA checks for
 * this flow: every POST is a JWS signed by the account key over a fresh nonce
 * and the exact URL, and the dns-01 challenge only validates when the TXT
 * record the relay published equals base64url(SHA-256(token.thumbprint)).
 */
import { X509Certificate, createPublicKey, randomBytes, verify, type KeyObject } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { dns01Value, jwkThumbprint } from '../../client/acme.ts';

interface Authorization {
  status: 'pending' | 'valid' | 'invalid';
  identifier: string;
  token: string;
  account: string;
}

interface Order {
  status: 'pending' | 'ready' | 'valid' | 'invalid';
  identifier: string;
  authorization: string;
  certificate?: string;
  account: string;
}

export interface MockAcme {
  readonly directoryUrl: string;
  readonly issued: string[];
  readonly accounts: number;
  close(): Promise<void>;
}

export async function startMockAcme(options: {
  lookupTxt(name: string): string[];
  signCsr(der: Buffer): string;
}): Promise<MockAcme> {
  const nonces = new Set<string>();
  const accounts = new Map<string, { key: KeyObject; thumbprint: string }>();
  const authorizations = new Map<string, Authorization>();
  const orders = new Map<string, Order>();
  const certificates = new Map<string, string>();
  const issued: string[] = [];
  let base = '';
  let counter = 0;
  const id = () => String(++counter);

  const server = http.createServer(async (req, res) => {
    const nonce = randomBytes(12).toString('base64url');
    nonces.add(nonce);
    res.setHeader('replay-nonce', nonce);
    res.setHeader('cache-control', 'no-store');
    const url = `${base}${req.url}`;
    const json = (status: number, body: unknown, location?: string) => {
      if (location) res.setHeader('location', location);
      res.writeHead(status, { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' });
      res.end(JSON.stringify(body));
    };
    const problem = (status: number, type: string, detail: string) =>
      json(status, { type: `urn:ietf:params:acme:error:${type}`, detail });

    if (req.method === 'GET' && req.url === '/directory') {
      return json(200, {
        newNonce: `${base}/new-nonce`,
        newAccount: `${base}/new-account`,
        newOrder: `${base}/new-order`,
        meta: { termsOfService: `${base}/terms/v1.pdf` },
      });
    }
    if (req.url === '/new-nonce') {
      res.writeHead(200);
      return res.end();
    }
    if (req.method !== 'POST') return problem(405, 'malformed', 'POST required');

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let jws: { protected: string; payload: string; signature: string };
    let header: { alg: string; nonce: string; url: string; jwk?: Record<string, string>; kid?: string };
    try {
      jws = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      header = JSON.parse(Buffer.from(jws.protected, 'base64url').toString('utf8'));
    } catch {
      return problem(400, 'malformed', 'bad JWS');
    }
    if (!nonces.delete(header.nonce)) return problem(400, 'badNonce', 'nonce unknown or reused');
    if (header.url !== url) return problem(401, 'unauthorized', 'JWS url does not match request url');
    if (header.alg !== 'ES256') return problem(400, 'badSignatureAlgorithm', 'ES256 only');
    let key: KeyObject;
    let accountUrl: string | undefined;
    if (header.jwk) {
      if (req.url !== '/new-account') return problem(400, 'malformed', 'jwk only allowed for new-account');
      key = createPublicKey({ key: header.jwk, format: 'jwk' });
    } else {
      const account = header.kid ? accounts.get(header.kid) : undefined;
      if (!account) return problem(400, 'accountDoesNotExist', 'unknown kid');
      key = account.key;
      accountUrl = header.kid;
    }
    const signed = Buffer.from(`${jws.protected}.${jws.payload}`);
    if (!verify('sha256', signed, { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(jws.signature, 'base64url'))) {
      return problem(403, 'unauthorized', 'bad signature');
    }
    const payload = jws.payload === '' ? undefined : JSON.parse(Buffer.from(jws.payload, 'base64url').toString('utf8'));
    const account = accountUrl ? accounts.get(accountUrl)! : undefined;

    if (req.url === '/new-account') {
      if (payload?.termsOfServiceAgreed !== true) return problem(403, 'userActionRequired', 'terms not agreed');
      const thumbprint = jwkThumbprint(header.jwk!);
      for (const [existing, value] of accounts) if (value.thumbprint === thumbprint) return json(200, { status: 'valid' }, existing);
      const location = `${base}/acct/${id()}`;
      accounts.set(location, { key, thumbprint });
      return json(201, { status: 'valid' }, location);
    }
    if (req.url === '/new-order') {
      const identifier = payload?.identifiers?.[0]?.value as string;
      const authorizationId = id();
      authorizations.set(authorizationId, { status: 'pending', identifier, token: randomBytes(16).toString('base64url'), account: accountUrl! });
      const orderId = id();
      orders.set(orderId, { status: 'pending', identifier, authorization: authorizationId, account: accountUrl! });
      return json(
        201,
        { status: 'pending', identifiers: [{ type: 'dns', value: identifier }], authorizations: [`${base}/authz/${authorizationId}`], finalize: `${base}/finalize/${orderId}` },
        `${base}/order/${orderId}`,
      );
    }
    const [, kind, objectId] = req.url!.split('/');
    if (kind === 'authz' || kind === 'chall') {
      const authorization = authorizations.get(objectId!);
      if (!authorization || authorization.account !== accountUrl) return problem(404, 'malformed', 'no such authorization');
      if (kind === 'chall' && authorization.status === 'pending') {
        const expected = dns01Value(authorization.token, account!.thumbprint);
        const published = options.lookupTxt(`_acme-challenge.${authorization.identifier}`);
        authorization.status = published.includes(expected) ? 'valid' : 'invalid';
      }
      const challenge = { type: 'dns-01', url: `${base}/chall/${objectId}`, token: authorization.token, status: authorization.status === 'pending' ? 'pending' : authorization.status };
      if (kind === 'chall') return json(200, challenge);
      return json(200, { status: authorization.status, identifier: { type: 'dns', value: authorization.identifier }, challenges: [challenge] });
    }
    if (kind === 'finalize' || kind === 'order') {
      const order = orders.get(objectId!);
      if (!order || order.account !== accountUrl) return problem(404, 'malformed', 'no such order');
      if (kind === 'finalize') {
        const authorization = authorizations.get(order.authorization)!;
        if (authorization.status !== 'valid') return problem(403, 'orderNotReady', 'authorization not valid');
        let pem: string;
        try {
          pem = options.signCsr(Buffer.from(String(payload?.csr), 'base64url'));
        } catch {
          return problem(400, 'badCSR', 'CSR rejected');
        }
        if (!new X509Certificate(pem).checkHost(order.identifier)) return problem(400, 'badCSR', 'CSR names the wrong host');
        const certificateId = id();
        certificates.set(certificateId, pem);
        issued.push(order.identifier);
        order.status = 'valid';
        order.certificate = `${base}/cert/${certificateId}`;
      }
      return json(200, { status: order.status, finalize: `${base}/finalize/${objectId}`, ...(order.certificate ? { certificate: order.certificate } : {}) });
    }
    if (kind === 'cert') {
      const pem = certificates.get(objectId!);
      if (!pem) return problem(404, 'malformed', 'no such certificate');
      res.writeHead(200, { 'content-type': 'application/pem-certificate-chain' });
      return res.end(pem);
    }
    return problem(404, 'malformed', 'unknown resource');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    directoryUrl: `${base}/directory`,
    issued,
    get accounts() {
      return accounts.size;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
