import { describe, expect, test } from 'bun:test';
import { defaultConfig } from '../src/core/config.ts';
import { DirectHttpEmailTransport, EmailClient } from '../src/core/email.ts';

describe('EmailClient', () => {
  test('keeps non-allowlisted and malformed worker failures on the generic email error boundary', async () => {
    const probes = [
      {
        response: new Response(JSON.stringify({
          error: { code: 'unsupported_filter', message: 'a typed client error must not escape a server failure' },
        }), { status: 500 }),
        status: 500,
        suggestion: '{"error":{"code":"unsupported_filter","message":"a typed client error must not escape a server failure"}}',
      },
      {
        response: new Response(JSON.stringify({
          error: {
            code: 'source_worker_error',
            message: 'Private source worker request failed before producing a safe result.',
          },
        }), { status: 500 }),
        status: 500,
        suggestion: '{"error":{"code":"source_worker_error","message":"Private source worker request failed before producing a safe result."}}',
      },
      {
        response: new Response('not-json-at-all', { status: 400 }),
        status: 400,
        suggestion: 'not-json-at-all',
      },
      {
        response: new Response(JSON.stringify({
          error: { code: 'internal_worker_failure', message: 'worker internals must stay private' },
        }), { status: 400 }),
        status: 400,
        suggestion: '{"error":{"code":"internal_worker_failure","message":"worker internals must stay private"}}',
      },
      {
        response: new Response(JSON.stringify({
          error: { message: 'code is absent' },
        }), { status: 400 }),
        status: 400,
        suggestion: '{"error":{"message":"code is absent"}}',
      },
    ];

    for (const probe of probes) {
      const transport = new DirectHttpEmailTransport(async () => probe.response);
      try {
        await transport.requestJson('http://worker.test/v1/source/index/search', { method: 'POST' });
        throw new Error('expected worker failure');
      } catch (error) {
        expect(error).toMatchObject({
          code: 'email_error',
          message: `Private email lane returned HTTP ${probe.status}.`,
          suggestion: probe.suggestion,
        });
      }
    }
  });

  test('preserves each allowlisted worker validation error code and message', async () => {
    for (const code of ['unsupported_filter', 'invalid_request'] as const) {
      const message = `${code} safe worker message`;
      const transport = new DirectHttpEmailTransport(async () => new Response(JSON.stringify({
        error: { code, message },
      }), { status: 400 }));

      try {
        await transport.requestJson('http://worker.test/v1/source/index/search', { method: 'POST' });
        throw new Error('expected worker validation failure');
      } catch (error) {
        expect(error).toMatchObject({ code, message, suggestion: undefined });
      }
    }
  });

  test('preserves a bounded policy refusal from the source answer route', async () => {
    const message = 'The explicitly requested standard-cloud analyst is not eligible for secure-local evidence.';
    const transport = new DirectHttpEmailTransport(async () => new Response(JSON.stringify({
      error: { code: 'source_index_policy_violation', message },
      policy: { raw_email_exposed: false },
    }), { status: 403 }));

    try {
      await transport.requestJson('http://worker.test/v1/source/answer', { method: 'POST' });
      throw new Error('expected worker policy refusal');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'source_index_policy_violation',
        message,
        suggestion: undefined,
      });
    }
  });

  test('does not promote a policy-shaped failure outside the exact answer boundary', async () => {
    const body = JSON.stringify({
      error: {
        code: 'source_index_policy_violation',
        message: 'A policy-shaped internal failure must stay generic.',
      },
    });
    const probes = [
      { url: 'http://worker.test/v1/source/answer', status: 500 },
      { url: 'http://worker.test/v1/source/index/search', status: 403 },
      { url: 'http://worker.test/v1/answer', status: 403 },
    ];

    for (const probe of probes) {
      const transport = new DirectHttpEmailTransport(
        async () => new Response(body, { status: probe.status }),
      );
      try {
        await transport.requestJson(probe.url, { method: 'POST' });
        throw new Error('expected generic worker failure');
      } catch (error) {
        expect(error).toMatchObject({
          code: 'email_error',
          message: `Private email lane returned HTTP ${probe.status}.`,
          suggestion: body,
        });
      }
    }
  });

  test('refuses typed promotion when the bounded envelope contains duplicate members', async () => {
    const bodies = [
      '{"error":{"code":"internal_worker_failure","code":"unsupported_filter","message":"safe"}}',
      '{"error":{"code":"unsupported_filter","message":"bad\\nline","message":"safe"}}',
    ];

    for (const body of bodies) {
      const transport = new DirectHttpEmailTransport(async () => new Response(body, { status: 400 }));

      try {
        await transport.requestJson('http://worker.test/v1/source/index/search', { method: 'POST' });
        throw new Error('expected worker validation failure');
      } catch (error) {
        expect(error).toMatchObject({
          code: 'email_error',
          message: 'Private email lane returned HTTP 400.',
          suggestion: body,
        });
      }
    }
  });

  test('refuses typed promotion for Unicode-escape-equivalent duplicate members', async () => {
    const bodies = [
      String.raw`{"error":{"code":"internal_worker_failure","\u0063ode":"invalid_request","message":"safe"}}`,
      String.raw`{"error":{"code":"invalid_request","message":"safe","😀":1,"\ud83d\ude00":2}}`,
      String.raw`{"error":{"code":"invalid_request","message":"safe","\ud800":1,"\uD800":2}}`,
    ];

    for (const body of bodies) {
      const transport = new DirectHttpEmailTransport(async () => new Response(body, { status: 400 }));

      try {
        await transport.requestJson('http://worker.test/v1/source/index/search', { method: 'POST' });
        throw new Error('expected worker validation failure');
      } catch (error) {
        expect(error).toMatchObject({
          code: 'email_error',
          message: 'Private email lane returned HTTP 400.',
          suggestion: body,
        });
      }
    }
  });

  test('keeps identical member names in sibling objects independent', async () => {
    const body = '{"error":{"code":"invalid_request","message":"safe","left":{"same":1},"right":{"same":2}}}';
    const transport = new DirectHttpEmailTransport(async () => new Response(body, { status: 400 }));

    try {
      await transport.requestJson('http://worker.test/v1/source/index/search', { method: 'POST' });
      throw new Error('expected worker validation failure');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'invalid_request',
        message: 'safe',
        suggestion: undefined,
      });
    }
  });

  test('conservatively refuses typed promotion beyond the scanner depth cap', async () => {
    const nestedEnvelope = (levels: number): string => (
      `{"error":{"code":"invalid_request","message":"safe","probe":${'['.repeat(levels)}null${']'.repeat(levels)}}}`
    );
    const withinCapBody = nestedEnvelope(62);
    const beyondCapBody = nestedEnvelope(63);

    const withinCapTransport = new DirectHttpEmailTransport(
      async () => new Response(withinCapBody, { status: 400 }),
    );
    try {
      await withinCapTransport.requestJson('http://worker.test/v1/source/index/search', { method: 'POST' });
      throw new Error('expected worker validation failure');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'invalid_request',
        message: 'safe',
        suggestion: undefined,
      });
    }

    const beyondCapTransport = new DirectHttpEmailTransport(
      async () => new Response(beyondCapBody, { status: 400 }),
    );
    try {
      await beyondCapTransport.requestJson('http://worker.test/v1/source/index/search', { method: 'POST' });
      throw new Error('expected worker validation failure');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'email_error',
        message: 'Private email lane returned HTTP 400.',
        suggestion: beyondCapBody,
      });
    }
  });

  test('keeps hostile deep nesting inside the generic transport error boundary', async () => {
    const body = `{"error":{"code":"invalid_request","message":"safe","probe":${'['.repeat(4_000)}null${']'.repeat(4_000)}}}`;
    expect(body.length).toBeLessThanOrEqual(8 * 1024);
    const transport = new DirectHttpEmailTransport(async () => new Response(body, { status: 400 }));

    try {
      await transport.requestJson('http://worker.test/v1/source/index/search', { method: 'POST' });
      throw new Error('expected worker validation failure');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'email_error',
        message: 'Private email lane returned HTTP 400.',
        suggestion: body,
      });
    }
  });

  test('rejects Unicode line separators but preserves safe worker messages verbatim', async () => {
    for (const unsafeMessage of ['safe\u2028injected', 'safe\u2029injected']) {
      const unsafeBody = JSON.stringify({
        error: { code: 'invalid_request', message: unsafeMessage },
      });
      const unsafeTransport = new DirectHttpEmailTransport(
        async () => new Response(unsafeBody, { status: 400 }),
      );

      try {
        await unsafeTransport.requestJson('http://worker.test/v1/source/index/search', { method: 'POST' });
        throw new Error('expected worker validation failure');
      } catch (error) {
        expect(error).toMatchObject({
          code: 'email_error',
          message: 'Private email lane returned HTTP 400.',
          suggestion: unsafeBody,
        });
      }
    }

    const paddedMessage = '  safe worker message  ';
    const safeTransport = new DirectHttpEmailTransport(async () => new Response(JSON.stringify({
      error: { code: 'invalid_request', message: paddedMessage },
    }), { status: 400 }));

    try {
      await safeTransport.requestJson('http://worker.test/v1/source/index/search', { method: 'POST' });
      throw new Error('expected worker validation failure');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'invalid_request',
        message: paddedMessage,
        suggestion: undefined,
      });
    }
  });

  test('keeps typed worker envelopes generic outside source-index search', async () => {
    const body = JSON.stringify({
      error: { code: 'invalid_request', message: 'answer request is invalid' },
    });
    const transport = new DirectHttpEmailTransport(
      async () => new Response(body, { status: 400 }),
    );

    try {
      await transport.requestJson('http://worker.test/v1/answer', { method: 'POST' });
      throw new Error('expected worker validation failure');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'email_error',
        message: 'Private email lane returned HTTP 400.',
        suggestion: body,
      });
    }
  });

  test('reports disabled email lane without reaching the network', async () => {
    const config = defaultConfig();
    const client = new EmailClient(
      config,
      new DirectHttpEmailTransport(async () => {
        throw new Error('network should not be called');
      }),
    );

    await expect(client.ping()).resolves.toMatchObject({
      reachable: false,
      configured: false,
      raw_email_exposed: false,
    });
  });

  test('answers through the configured private email lane without raw bodies', async () => {
    const config = defaultConfig();
    config.email.enabled = true;
    config.email.baseUrl = 'http://127.0.0.1:8010/v1';
    const requests: Request[] = [];
    const client = new EmailClient(
      config,
      new DirectHttpEmailTransport(async (input, init) => {
        requests.push(new Request(input, init));
        return jsonResponse({
          answer: 'The follow-up is due Friday.',
          evidence: [{ id: 'gmail:thread-1', subject: 'Project follow-up' }],
          audit: {
            request_id: 'request-1',
            queries_attempted: 1,
            metadata_hits: 1,
            evidence_count: 1,
            reasoner_ms: 12,
            fallback_used: false,
            planner_used: false,
            planner_fallback_used: true,
            planned_search_count: 0,
            planner_failure_reason: 'invalid_json',
            retrieval_searches_attempted: 1,
            retrieval_search_summaries: [
              { source: 'baseline', index: 0, hits: 1, new_candidates_after_dedupe: 1, capped: false },
            ],
          },
        });
      }),
    );

    const result = await client.answer({
      question: 'When is the follow-up due?',
      from: 'alex@example.com',
      maxMessages: 3,
    });

    expect(result).toEqual({
      answer: 'The follow-up is due Friday.',
      evidence: [{ id: 'gmail:thread-1', subject: 'Project follow-up' }],
      audit: {
        request_id: 'request-1',
        queries_attempted: 1,
        metadata_hits: 1,
        evidence_count: 1,
        reasoner_ms: 12,
        fallback_used: false,
        planner_used: false,
        planner_fallback_used: true,
        planned_search_count: 0,
        planner_failure_reason: 'invalid_json',
        retrieval_searches_attempted: 1,
        retrieval_search_summaries: [
          { source: 'baseline', index: 0, hits: 1, new_candidates_after_dedupe: 1, capped: false },
        ],
      },
      policy: {
        raw_email_exposed: false,
        reasoning_lane: 'delphi_local',
      },
    });
    expect(requests[0]?.url).toBe('http://127.0.0.1:8010/v1/answer');
    expect(await requests[0]?.json()).toEqual({
      question: 'When is the follow-up due?',
      from: 'alex@example.com',
      max_messages: 3,
    });
  });

  test('rejects private email lane responses that include raw message bodies', async () => {
    const config = defaultConfig();
    config.email.enabled = true;
    const client = new EmailClient(
      config,
      new DirectHttpEmailTransport(async () => jsonResponse({
        answer: 'Here is the body.',
        raw_messages: [{ body: 'private email' }],
      })),
    );

    await expect(client.answer({ question: 'What did it say?' })).rejects.toThrow(
      'forbidden raw field "raw_messages"',
    );
  });

  test('rejects audit responses that include raw snippet fields', async () => {
    const config = defaultConfig();
    config.email.enabled = true;
    const client = new EmailClient(
      config,
      new DirectHttpEmailTransport(async () => jsonResponse({
        answer: 'No raw audit should leave the lane.',
        audit: {
          request_id: 'request-1',
          queries_attempted: 1,
          metadata_hits: 1,
          evidence_count: 1,
          reasoner_ms: 12,
          fallback_used: false,
          snippets: ['private preview'],
        },
      })),
    );

    await expect(client.answer({ question: 'What did it say?' })).rejects.toThrow(
      'forbidden raw field "audit.snippets"',
    );
  });

  test('email_search fails closed unless local packet dev gate is enabled', async () => {
    const config = defaultConfig();
    config.email.enabled = true;
    const client = new EmailClient(
      config,
      new DirectHttpEmailTransport(async () => {
        throw new Error('network should not be called');
      }),
    );

    await expect(client.search({ query: 'from:alex@example.com' })).rejects.toThrow(
      'Email source packets require an approved local/private session.',
    );
  });

  test('email_search calls the private worker and accepts sanitized local packet fields when gated', async () => {
    const config = defaultConfig();
    config.email.enabled = true;
    config.email.localPacketsDevEnabled = true;
    config.email.baseUrl = 'http://127.0.0.1:8010/v1';
    const requests: Request[] = [];
    const client = new EmailClient(
      config,
      new DirectHttpEmailTransport(async (input, init) => {
        requests.push(new Request(input, init));
        return jsonResponse({
          packet: {
            kind: 'email_source_packet',
            packet_id: 'packet-1',
            source: 'gmail',
            account: 'person@example.com',
            items: [{
              item_id: 'msg-1',
              thread_id: 'thread-1',
              subject: 'Visit',
              from: 'admissions@example.com',
              date: '2026-05-02',
              sanitized_text: 'Sanitized appointment details.',
              provenance: {
                source: 'gmail',
                message_id: 'msg-1',
                thread_id: 'thread-1',
              },
            }],
          },
          audit: {
            request_id: 'request-1',
            queries_attempted: 1,
            metadata_hits: 1,
            items_returned: 1,
            sanitized_reads_attempted: 1,
            sanitized_reads_succeeded: 1,
            truncated: false,
            local_packet: true,
            raw_email_exposed: false,
          },
          policy: {
            raw_email_exposed: false,
            local_only: true,
            requires_local_session: true,
          },
        });
      }),
    );

    const result = await client.search({
      query: 'OpenApply appointment',
      from: 'admissions@example.com',
      maxMessages: 3,
    });

    expect(result.packet.items[0]?.sanitized_text).toBe('Sanitized appointment details.');
    expect(requests[0]?.url).toBe('http://127.0.0.1:8010/v1/search');
    expect(await requests[0]?.json()).toEqual({
      query: 'OpenApply appointment',
      from: 'admissions@example.com',
      max_messages: 3,
    });
  });

  test('email_search rejects forbidden raw packet field names', async () => {
    const config = defaultConfig();
    config.email.enabled = true;
    config.email.localPacketsDevEnabled = true;
    const client = new EmailClient(
      config,
      new DirectHttpEmailTransport(async () => jsonResponse({
        packet: {
          kind: 'email_source_packet',
          packet_id: 'packet-1',
          source: 'gmail',
          items: [{ body: 'private email' }],
        },
      })),
    );

    await expect(client.search({ query: 'anything' })).rejects.toThrow(
      'forbidden raw field "packet.items.0.body"',
    );
  });

  test('email_index_sync fails closed unless admin dev gate is enabled', async () => {
    const config = defaultConfig();
    config.email.enabled = true;
    const client = new EmailClient(
      config,
      new DirectHttpEmailTransport(async () => {
        throw new Error('network should not be called');
      }),
    );

    await expect(client.indexSync({ newerThanDays: 7, maxMessages: 5 })).rejects.toThrow(
      'Email index sync requires the explicit developer/admin proof gate.',
    );
  });

  test('email_index_embed fails closed unless admin dev gate is enabled', async () => {
    const config = defaultConfig();
    config.email.enabled = true;
    const client = new EmailClient(
      config,
      new DirectHttpEmailTransport(async () => {
        throw new Error('network should not be called');
      }),
    );

    await expect(client.indexEmbed({ account: 'person@example.com' })).rejects.toThrow(
      'Email index embedding requires the explicit developer/admin proof gate.',
    );
  });

  test('email_index_search fails closed unless local packet dev gate is enabled', async () => {
    const config = defaultConfig();
    config.email.enabled = true;
    const client = new EmailClient(
      config,
      new DirectHttpEmailTransport(async () => {
        throw new Error('network should not be called');
      }),
    );

    await expect(client.indexSearch({ query: 'school visit' })).rejects.toThrow(
      'Email index source packets require an approved local/private session.',
    );
  });

  test('source_answer fails closed when the source-index product surface is disabled', async () => {
    const config = defaultConfig();
    config.email.enabled = true;
    config.sourceIndex.enabled = false;
    const client = new EmailClient(
      config,
      new DirectHttpEmailTransport(async () => {
        throw new Error('network should not be called');
      }),
    );

    await expect(client.sourceAnswer({ question: 'school visit' })).rejects.toThrow(
      'Source index answers are disabled.',
    );
    await expect(client.sourceIndexStatus()).rejects.toThrow(
      'Source index status is disabled.',
    );
  });

  test('source_answer calls the private source worker and accepts only Castor-safe bridge output', async () => {
    const config = defaultConfig();
    config.email.enabled = true;
    config.email.baseUrl = 'http://127.0.0.1:8010/v1';
    const requests: Request[] = [];
    const client = new EmailClient(
      config,
      new DirectHttpEmailTransport(async (input, init) => {
        requests.push(new Request(input, init));
        return jsonResponse({
          answer: 'I found 1 safe source result with provenance.',
          evidence: [{
            corpus_id: 'internal.drive.docs',
            trust_domain: 'internal',
            family: 'file',
            provider: 'google_drive',
            provider_item_id: 'drive-doc-1',
            title: 'Policy note',
          }],
          audit: {
            searched_corpora: ['internal.drive.docs'],
            skipped_corpora: [],
            lane_audits: [],
            self_heal: {
              attempted: true,
              corpus_id: 'secure_local.dropbox.files',
              entry_id_hash: 'entry-hash',
              provider_file_id_hash: 'file-hash',
              path: '/Approved/Fee Estimate.pdf',
              prior_state: {
                extraction_status: 'metadata_only',
                extraction_completeness: 'metadata_only',
              },
              action: 'forced_reextract',
              outcome: 'in_progress',
              retry_after_ms: 5000,
              reason: 'inline_batch_did_not_index',
            },
            answer_synthesis: {
              analyst_backend: 'venice',
              requested_analyst_provider: 'venice',
              requested_analyst_model: 'zai-org-glm-5-1',
              analyst_fallback: {
                from: 'venice',
                to: 'local',
                reason: 'timeout',
                elapsed_ms: 20_001,
                timeout_ms: 20_000,
              },
              private_context_used: false,
              secure_local_items_consulted: 0,
              internal_items_consulted: 1,
              raw_source_exposed: false,
            },
            latency_ms: 3,
            phase_timings: {
              lane_setup_ms: 0,
              bulk_gate_ms: 0,
              evidence_pack_ms: 1,
              self_heal_ms: 4,
              analyst_ms: 2,
              release_gate_ms: 0,
              total_ms: 3,
            },
            raw_source_exposed: false,
          },
          policy: {
            raw_source_exposed: false,
            source_packets_exposed: false,
            internal_content_exposed: true,
            secure_local_content_exposed: false,
            castor_safe_bridge: true,
          },
          internal_context: {
            kind: 'internal_document_context',
            trust_domain: 'internal',
            total_chars: 37,
            items: [{
              corpus_id: 'internal.drive.docs',
              provider: 'google_drive',
              provider_file_id: 'drive-doc-1',
              passage: 'Visible internal policy note context.',
              passage_chars: 37,
              truncated: false,
              source_instruction_flags: [],
            }],
          },
        });
      }),
    );

    const result = await client.sourceAnswer({
      question: 'Find school visit sources',
      query: 'school visit',
      account: 'person@example.com',
      corpusId: 'internal.drive.docs',
      approvedScopeKey: 'dropbox.personal:/Approved',
      chatScope: 'telegram.personal:chat:chat-porto',
      conversationId: 'chat-porto',
      selectedItems: [{
        corpus_id: 'internal.drive.docs',
        family: 'file',
        provider: 'google_drive',
        account_scope: 'person@example.com',
        provider_item_id: 'drive-doc-1',
        local_item_id: 'person@example.com:drive-doc-1',
        title: 'Policy note',
      }],
      retrievalMode: 'keyword',
      analystProvider: 'venice',
      analystModel: 'zai-org-glm-5-1',
      maxResults: 3,
      includeInternal: true,
      includeSecureLocal: false,
      includeSecureLocalContent: true,
      includeInternalContent: true,
      internalContentMaxBytes: 12_000,
      timeoutMs: 600_000,
    });

    expect(result.policy).toEqual({
      raw_source_exposed: false,
      source_packets_exposed: false,
      internal_content_exposed: true,
      secure_local_content_exposed: false,
      castor_safe_bridge: true,
    });
    expect(result.internal_context).toMatchObject({
      kind: 'internal_document_context',
      items: [expect.objectContaining({
        passage: 'Visible internal policy note context.',
      })],
    });
    expect(result.audit.answer_synthesis).toMatchObject({
      analyst_backend: 'venice',
      requested_analyst_provider: 'venice',
      requested_analyst_model: 'zai-org-glm-5-1',
      analyst_fallback: {
        from: 'venice',
        to: 'local',
        reason: 'timeout',
        elapsed_ms: 20_001,
        timeout_ms: 20_000,
      },
      raw_source_exposed: false,
    });
    expect(result.audit.self_heal).toEqual({
      attempted: true,
      corpus_id: 'secure_local.dropbox.files',
      entry_id_hash: 'entry-hash',
      provider_file_id_hash: 'file-hash',
      prior_state: {
        extraction_status: 'metadata_only',
        extraction_completeness: 'metadata_only',
      },
      action: 'forced_reextract',
      outcome: 'in_progress',
      retry_after_ms: 5000,
      reason: 'inline_batch_did_not_index',
    });
    expect(result.audit.phase_timings).toEqual({
      lane_setup_ms: 0,
      bulk_gate_ms: 0,
      evidence_pack_ms: 1,
      self_heal_ms: 4,
      analyst_ms: 2,
      release_gate_ms: 0,
      total_ms: 3,
    });
    expect(requests[0]?.url).toBe('http://127.0.0.1:8010/v1/source/answer');
    expect(await requests[0]?.json()).toEqual({
      question: 'Find school visit sources',
      query: 'school visit',
      account: 'person@example.com',
      corpus_id: 'internal.drive.docs',
      approved_scope_key: 'dropbox.personal:/Approved',
      chat_scope: 'telegram.personal:chat:chat-porto',
      conversation_id: 'chat-porto',
      selected_items: [{
        corpus_id: 'internal.drive.docs',
        family: 'file',
        provider: 'google_drive',
        account_scope: 'person@example.com',
        provider_item_id: 'drive-doc-1',
        local_item_id: 'person@example.com:drive-doc-1',
        title: 'Policy note',
      }],
      retrieval_mode: 'keyword',
      analyst_provider: 'venice',
      analyst_model: 'zai-org-glm-5-1',
      max_results: 3,
      include_secure_local: false,
      include_secure_local_content: true,
      include_internal: true,
      include_internal_content: true,
      internal_content_max_bytes: 12_000,
      timeout_ms: 600_000,
    });
  });

  test('source_answer rejects raw source fields from the private source worker', async () => {
    const config = defaultConfig();
    config.email.enabled = true;
    const client = new EmailClient(
      config,
      new DirectHttpEmailTransport(async () => jsonResponse({
        answer: 'Unsafe',
        evidence: [{ body: 'private source body' }],
      })),
    );

    await expect(client.sourceAnswer({ question: 'anything' })).rejects.toThrow(
      'forbidden raw field "evidence.0.body"',
    );
  });

  test('source_answer drops self-heal audit when worker returns unknown self-heal enums', async () => {
    const config = defaultConfig();
    config.email.enabled = true;
    const variants = [
      { outcome: 'new_outcome', action: 'forced_reextract' },
      { outcome: 'in_progress', action: 'new_action' },
    ];
    for (const variant of variants) {
      const client = new EmailClient(
        config,
        new DirectHttpEmailTransport(async () => jsonResponse(sourceAnswerPayload({
          self_heal: {
            attempted: true,
            outcome: variant.outcome,
            action: variant.action,
          },
        }))),
      );

      const result = await client.sourceAnswer({ question: 'anything' });

      expect(result.audit.self_heal).toBeUndefined();
    }
  });

  test('source_answer keeps strict validation for malformed known self-heal fields', async () => {
    const config = defaultConfig();
    config.email.enabled = true;
    const client = new EmailClient(
      config,
      new DirectHttpEmailTransport(async () => jsonResponse(sourceAnswerPayload({
        self_heal: {
          attempted: true,
          outcome: 'in_progress',
          prior_state: 'not-an-object',
        },
      }))),
    );

    await expect(client.sourceAnswer({ question: 'anything' })).rejects.toThrow(
      'Private email lane response was not a JSON object.',
    );
  });

  test('source_index_status calls the private source worker and accepts read-only Castor-visible output', async () => {
    const config = defaultConfig();
    config.email.enabled = true;
    config.email.baseUrl = 'http://127.0.0.1:8010/v1';
    const requests: Request[] = [];
    const client = new EmailClient(
      config,
      new DirectHttpEmailTransport(async (input, init) => {
        requests.push(new Request(input, init));
        return jsonResponse({
          kind: 'source_index_status',
          generated_at: '2026-05-17T12:00:00.000Z',
          corpora: [{
            corpus_id: 'internal.drive.docs',
            family: 'file',
            trust_domain: 'internal',
            provider: 'google_drive',
            configured: true,
            counts: { indexed_items: 1 },
            item_metadata_returned: true,
            items: [{
              provider: 'google_drive',
              provider_file_id: 'drive-doc-1',
              title: 'Policy note',
              has_indexed_text: true,
              chunk_count: 1,
              indexed_text_chars: 42,
            }],
          }],
          sender_aggregation: {
            population: 'indexed_active_items',
            ranking: 'exact',
            senders: [{ senderId: 'sender-1', displayLabel: 'Ada', messageCount: 2 }],
            coverage: { indexedItems: 2, unattributedItems: 0 },
          },
          policy: {
            read_only: true,
            raw_source_exposed: false,
            source_packets_exposed: false,
            source_text_returned: false,
            secure_local_item_metadata_exposed: false,
            castor_visible: true,
          },
        });
      }),
    );

    const result = await client.sourceIndexStatus({
      account: 'person@example.com',
      corpusId: 'internal.drive.docs',
      conversationId: 'chat-1',
      includeSenderAggregation: true,
      maxSenders: 10,
      includePathPrefixes: ['/1 Projects'],
      excludePathPrefixes: ['/1 Projects/Archive'],
      extractorKind: 'local_ocr_tesseract',
      extractorVersion: '2026-06-27-local-ocr-qa-retry-v1',
      qaVerdicts: ['qa_metadata_only_gap'],
      mimeTypes: ['application/pdf'],
      requiredArtifactKind: 'text',
      requiredArtifactWarning: 'ocr_required',
      sourceExtractorKinds: ['local_text'],
      sourceJobStatuses: ['metadata_only'],
      includeItems: true,
      maxItems: 10,
      query: 'Policy',
    });

    expect(result).toMatchObject({
      kind: 'source_index_status',
      corpora: [expect.objectContaining({
        corpus_id: 'internal.drive.docs',
        items: [expect.objectContaining({ title: 'Policy note' })],
      })],
      policy: { read_only: true, raw_source_exposed: false },
      sender_aggregation: expect.objectContaining({ ranking: 'exact' }),
    });
    expect(requests[0]?.url).toBe('http://127.0.0.1:8010/v1/source/index/status');
    expect(await requests[0]?.json()).toEqual({
      account: 'person@example.com',
      corpus_id: 'internal.drive.docs',
      conversation_id: 'chat-1',
      include_sender_aggregation: true,
      max_senders: 10,
      include_path_prefixes: ['/1 Projects'],
      exclude_path_prefixes: ['/1 Projects/Archive'],
      extractor_kind: 'local_ocr_tesseract',
      extractor_version: '2026-06-27-local-ocr-qa-retry-v1',
      qa_verdicts: ['qa_metadata_only_gap'],
      mime_types: ['application/pdf'],
      required_artifact_kind: 'text',
      required_artifact_warning: 'ocr_required',
      source_extractor_kinds: ['local_text'],
      source_job_statuses: ['metadata_only'],
      include_items: true,
      max_items: 10,
      query: 'Policy',
    });
  });

  test('source_index_status rejects raw source fields from the private source worker', async () => {
    const config = defaultConfig();
    config.email.enabled = true;
    const client = new EmailClient(
      config,
      new DirectHttpEmailTransport(async () => jsonResponse({
        kind: 'source_index_status',
        generated_at: '2026-05-17T12:00:00.000Z',
        corpora: [{ message: 'private email metadata' }],
      })),
    );

    await expect(client.sourceIndexStatus()).rejects.toThrow(
      'forbidden raw field "corpora.0.message"',
    );
  });

  test('source-index operational surfaces reject raw paths, scopes, cursors, and sessions', async () => {
    const config = defaultConfig();
    config.email.enabled = true;
    config.email.indexAdminDevEnabled = true;
    config.email.localPacketsDevEnabled = true;
    const client = new EmailClient(
      config,
      new DirectHttpEmailTransport(async (input) => {
        if (String(input).endsWith('/source/index/status')) {
          return jsonResponse({
            kind: 'source_index_status',
            generated_at: '2026-05-20T10:00:00.000Z',
            corpora: [{ corpus_id: 'secure_local.telegram.messages', chat_scope: 'telegram.personal:chat:secret' }],
            policy: {
              read_only: true,
              raw_source_exposed: false,
              source_packets_exposed: false,
              source_text_returned: false,
              secure_local_item_metadata_exposed: false,
              castor_visible: true,
            },
          });
        }
        if (String(input).endsWith('/source/index/sync')) {
          return jsonResponse({
            sync_run_id: 'sync-1',
            status: 'completed',
            provider_cursor: 'offset_id:100',
            policy: { raw_source_exposed: false, source_text_returned: false },
          });
        }
        return jsonResponse({
          kind: 'source_index_search',
          corpus_id: 'secure_local.dropbox.files',
          retrieval_source: 'local_index',
          hits: [{ path_display: '/Secret/Path.pdf' }],
          audit: {
            request_id: 'request-1',
            retrieval_source: 'local_index',
            queries_attempted: 1,
            metadata_hits: 1,
            items_returned: 1,
            latency_ms: 1,
            raw_source_exposed: false,
            source_text_returned: false,
          },
          policy: {
            raw_source_exposed: false,
            source_text_returned: false,
            source_packets_exposed: false,
            local_only: true,
            trust_domain: 'secure_local',
          },
        });
      }),
    );

    await expect(client.sourceIndexStatus()).rejects.toThrow(
      'forbidden operational field "corpora.0.chat_scope"',
    );
    await expect(client.sourceIndexSync({
      corpusId: 'secure_local.telegram.messages',
      chatScope: 'telegram.personal:chat:secret',
    })).rejects.toThrow('forbidden operational field "provider_cursor"');
    await expect(client.sourceIndexSearch({ corpusId: 'secure_local.dropbox.files', query: 'secret' })).rejects.toThrow(
      'forbidden operational field "hits.0.path_display"',
    );
  });

  test('source_index_search accepts explicit Dropbox locators without raw source fields', async () => {
    const config = defaultConfig();
    config.email.enabled = true;
    const requests: Request[] = [];
    const client = new EmailClient(
      config,
      new DirectHttpEmailTransport(async (input, init) => {
        requests.push(new Request(input, init));
        return jsonResponse({
          kind: 'source_index_search',
          corpus_id: 'secure_local.dropbox.files',
          retrieval_source: 'local_index',
          hits: [{
            sourceItem: {
              family: 'file',
              provider: 'dropbox',
              accountScope: 'personal',
              providerItemId: 'id:file-okc',
              providerFileId: 'id:file-okc',
              localItemId: 'personal:id:file-okc',
            },
            provenance: {
              citation: {
                title: 'okc.pdf',
                sourceLabel: 'Dropbox',
              },
            },
            candidateId: 'secure_local.dropbox.files:personal:id:file-okc',
            rank: 1,
            locator: {
              display_path: '/Olympus Approved/SECRET_PATH/Dating/okc.pdf',
              parent_display_path: '/Olympus Approved/SECRET_PATH/Dating',
              dropbox_web_url: 'https://www.dropbox.com/home/Olympus%20Approved/SECRET_PATH/Dating/okc.pdf',
              parent_dropbox_web_url: 'https://www.dropbox.com/home/Olympus%20Approved/SECRET_PATH/Dating',
              finder_url: 'file:///Users/owner/Library/CloudStorage/Dropbox/Olympus%20Approved/SECRET_PATH/Dating/okc.pdf',
              parent_finder_url: 'file:///Users/owner/Library/CloudStorage/Dropbox/Olympus%20Approved/SECRET_PATH/Dating',
            },
          }],
          audit: {
            request_id: 'request-1',
            retrieval_source: 'local_index',
            queries_attempted: 1,
            metadata_hits: 1,
            items_returned: 1,
            latency_ms: 1,
            raw_source_exposed: false,
            source_text_returned: false,
            locators_requested: true,
          },
          policy: {
            raw_source_exposed: false,
            source_text_returned: false,
            source_packets_exposed: false,
            local_only: true,
            trust_domain: 'secure_local',
            locators_exposed: true,
            locator_release: 'explicit_request',
          },
        });
      }),
    );

    const result = await client.sourceIndexSearch({
      corpusId: 'secure_local.dropbox.files',
      query: 'dating profile',
      account: 'personal',
      includeLocators: true,
      maxResults: 5,
    });

    expect(result).toMatchObject({
      kind: 'source_index_search',
      corpus_id: 'secure_local.dropbox.files',
      hits: [{
        locator: {
          display_path: '/Olympus Approved/SECRET_PATH/Dating/okc.pdf',
          parent_display_path: '/Olympus Approved/SECRET_PATH/Dating',
        },
      }],
      audit: {
        locators_requested: true,
        raw_source_exposed: false,
        source_text_returned: false,
      },
      policy: {
        locators_exposed: true,
        locator_release: 'explicit_request',
        raw_source_exposed: false,
        source_text_returned: false,
      },
    });
    expect(await requests[0]?.json()).toEqual({
      query: 'dating profile',
      corpus_id: 'secure_local.dropbox.files',
      account: 'personal',
      max_results: 5,
      include_locators: true,
    });
  });

  test('source_index_search rejects locator release that was not explicitly requested', async () => {
    const config = defaultConfig();
    config.email.enabled = true;
    const client = new EmailClient(
      config,
      new DirectHttpEmailTransport(async () => jsonResponse({
        kind: 'source_index_search',
        corpus_id: 'secure_local.dropbox.files',
        retrieval_source: 'local_index',
        hits: [{
          locator: {
            display_path: '/private/path.pdf',
          },
        }],
        audit: {
          request_id: 'request-locator',
          retrieval_source: 'local_index',
          queries_attempted: 1,
          metadata_hits: 1,
          items_returned: 1,
          latency_ms: 1,
          raw_source_exposed: false,
          source_text_returned: false,
          locators_requested: true,
        },
        policy: {
          raw_source_exposed: false,
          source_text_returned: false,
          source_packets_exposed: false,
          local_only: true,
          trust_domain: 'secure_local',
          locators_exposed: true,
          locator_release: 'explicit_request',
        },
      })),
    );

    await expect(client.sourceIndexSearch({
      corpusId: 'secure_local.dropbox.files',
      query: 'dating profile',
    })).rejects.toThrow('source index locator release requires include_locators=true');
  });

  test('source_index_search rejects locator payloads without locator release policy', async () => {
    const config = defaultConfig();
    config.email.enabled = true;
    const client = new EmailClient(
      config,
      new DirectHttpEmailTransport(async () => jsonResponse({
        kind: 'source_index_search',
        corpus_id: 'secure_local.dropbox.files',
        retrieval_source: 'local_index',
        hits: [{
          locator: {
            display_path: '/private/path.pdf',
          },
        }],
        audit: {
          request_id: 'request-locator-policy',
          retrieval_source: 'local_index',
          queries_attempted: 1,
          metadata_hits: 1,
          items_returned: 1,
          latency_ms: 1,
          raw_source_exposed: false,
          source_text_returned: false,
        },
        policy: {
          raw_source_exposed: false,
          source_text_returned: false,
          source_packets_exposed: false,
          local_only: true,
          trust_domain: 'secure_local',
        },
      })),
    );

    await expect(client.sourceIndexSearch({
      corpusId: 'secure_local.dropbox.files',
      query: 'dating profile',
      includeLocators: true,
    })).rejects.toThrow('source index search returned locator fields without locator release policy');
  });

  test('source_index_search rejects loose locator path and URL fields without locator release policy', async () => {
    const config = defaultConfig();
    config.email.enabled = true;
    const client = new EmailClient(
      config,
      new DirectHttpEmailTransport(async () => jsonResponse({
        kind: 'source_index_search',
        corpus_id: 'secure_local.dropbox.files',
        retrieval_source: 'local_index',
        hits: [{
          display_path: '/private/path.pdf',
          finder_url: 'file:///Users/private/path.pdf',
          dropbox_web_url: 'https://www.dropbox.com/home/private/path.pdf',
          locator_uri: 'dropbox://private/path.pdf',
        }],
        audit: {
          request_id: 'request-loose-locator-policy',
          retrieval_source: 'local_index',
          queries_attempted: 1,
          metadata_hits: 1,
          items_returned: 1,
          latency_ms: 1,
          raw_source_exposed: false,
          source_text_returned: false,
        },
        policy: {
          raw_source_exposed: false,
          source_text_returned: false,
          source_packets_exposed: false,
          local_only: true,
          trust_domain: 'secure_local',
        },
      })),
    );

    await expect(client.sourceIndexSearch({
      corpusId: 'secure_local.dropbox.files',
      query: 'dating profile',
      includeLocators: true,
    })).rejects.toThrow('source index search returned locator fields without locator release policy');
  });

  test('source_index_search rejects false locator policy envelopes and altered Dropbox locator shapes', async () => {
    const config = defaultConfig();
    config.email.enabled = true;
    const validLocator = {
      display_path: '/2 Areas/file.pdf',
      parent_display_path: '/2 Areas',
      dropbox_web_url: 'https://www.dropbox.com/home/2%20Areas/file.pdf',
      parent_dropbox_web_url: 'https://www.dropbox.com/home/2%20Areas',
    };
    const validHit = {
      sourceItem: {
        family: 'file',
        provider: 'dropbox',
        accountScope: 'personal',
        providerItemId: 'id:file',
        providerFileId: 'id:file',
        localItemId: 'personal:id:file',
      },
      locator: validLocator,
    };
    const cases = [
      {
        name: 'missing intent audit without exposure',
        hits: [],
        audit: {},
        policy: {},
        message: 'request audit must report include_locators=true intent',
      },
      {
        name: 'policy without a payload',
        hits: [],
        audit: { locators_requested: true },
        policy: { locators_exposed: true, locator_release: 'explicit_request' },
        message: 'requires at least one released locator',
      },
      {
        name: 'policy without request audit',
        hits: [validHit],
        audit: {},
        policy: { locators_exposed: true, locator_release: 'explicit_request' },
        message: 'requires include_locators=true',
      },
      {
        name: 'policy without explicit release mode',
        hits: [validHit],
        audit: { locators_requested: true },
        policy: { locators_exposed: true },
        message: 'must require explicit request release',
      },
      {
        name: 'missing required field',
        hits: [{ ...validHit, locator: { ...validLocator, parent_display_path: undefined } }],
        audit: { locators_requested: true },
        policy: { locators_exposed: true, locator_release: 'explicit_request' },
        message: 'requires string field parent_display_path',
      },
      {
        name: 'unknown locator field',
        hits: [{ ...validHit, locator: { ...validLocator, root_config: '/private' } }],
        audit: { locators_requested: true },
        policy: { locators_exposed: true, locator_release: 'explicit_request' },
        message: 'contains an unsupported field',
      },
      {
        name: 'wrong field type',
        hits: [{ ...validHit, locator: { ...validLocator, dropbox_web_url: 42 } }],
        audit: { locators_requested: true },
        policy: { locators_exposed: true, locator_release: 'explicit_request' },
        message: 'requires string field dropbox_web_url',
      },
      {
        name: 'loose locator sibling',
        hits: [{ ...validHit, display_path: '/leak' }],
        audit: { locators_requested: true },
        policy: { locators_exposed: true, locator_release: 'explicit_request' },
        message: 'must appear only in hit.locator',
      },
      {
        name: 'relative display path',
        hits: [{ ...validHit, locator: { ...validLocator, display_path: '2 Areas/file.pdf' } }],
        audit: { locators_requested: true },
        policy: { locators_exposed: true, locator_release: 'explicit_request' },
        message: 'paths must be rooted normalized strings',
      },
      {
        name: 'arbitrary web URL',
        hits: [{ ...validHit, locator: { ...validLocator, dropbox_web_url: 'https://example.test/file.pdf' } }],
        audit: { locators_requested: true },
        policy: { locators_exposed: true, locator_release: 'explicit_request' },
        message: 'must use the Dropbox home HTTPS origin',
      },
      {
        name: 'non-file Finder URL',
        hits: [{ ...validHit, locator: { ...validLocator, finder_url: 'https://example.test/file.pdf' } }],
        audit: { locators_requested: true },
        policy: { locators_exposed: true, locator_release: 'explicit_request' },
        message: 'finder_url must use the file URL scheme',
      },
    ] as const;

    for (const fixture of cases) {
      const client = new EmailClient(
        config,
        new DirectHttpEmailTransport(async () => jsonResponse({
          kind: 'source_index_search',
          corpus_id: 'secure_local.dropbox.files',
          retrieval_source: 'local_index',
          hits: fixture.hits,
          audit: {
            request_id: `request-${fixture.name}`,
            retrieval_source: 'local_index',
            queries_attempted: 1,
            metadata_hits: fixture.hits.length,
            items_returned: fixture.hits.length,
            latency_ms: 1,
            raw_source_exposed: false,
            source_text_returned: false,
            ...fixture.audit,
          },
          policy: {
            raw_source_exposed: false,
            source_text_returned: false,
            source_packets_exposed: false,
            local_only: true,
            trust_domain: 'secure_local',
            ...fixture.policy,
          },
        })),
      );
      await expect(client.sourceIndexSearch({
        corpusId: 'secure_local.dropbox.files',
        query: 'locator rejection matrix',
        includeLocators: true,
      })).rejects.toThrow(fixture.message);
    }
  });

  test('source_index_search rejects locator release for a corpus not declared as Dropbox file search', async () => {
    const config = defaultConfig();
    config.email.enabled = true;
    const client = new EmailClient(
      config,
      new DirectHttpEmailTransport(async () => jsonResponse({
        kind: 'source_index_search',
        corpus_id: 'internal.drive.docs',
        retrieval_source: 'local_index',
        hits: [{
          sourceItem: {
            family: 'file',
            provider: 'dropbox',
            accountScope: 'personal',
            providerItemId: 'spoofed-dropbox-hit',
            localItemId: 'personal:spoofed-dropbox-hit',
          },
          locator: {
            display_path: '/2 Areas/file.pdf',
            parent_display_path: '/2 Areas',
            dropbox_web_url: 'https://www.dropbox.com/home/2%20Areas/file.pdf',
            parent_dropbox_web_url: 'https://www.dropbox.com/home/2%20Areas',
          },
        }],
        audit: {
          request_id: 'request-drive-locator-spoof',
          retrieval_source: 'local_index',
          queries_attempted: 1,
          metadata_hits: 1,
          items_returned: 1,
          latency_ms: 1,
          raw_source_exposed: false,
          source_text_returned: false,
          locators_requested: true,
        },
        policy: {
          raw_source_exposed: false,
          source_text_returned: false,
          source_packets_exposed: false,
          local_only: false,
          trust_domain: 'internal',
          locators_exposed: true,
          locator_release: 'explicit_request',
        },
      })),
    );

    await expect(client.sourceIndexSearch({
      corpusId: 'internal.drive.docs',
      query: 'spoofed locator',
      includeLocators: true,
    })).rejects.toThrow('locator release is not declared for the selected corpus');
  });

  test('source_index_search rejects mismatched worker response corpus', async () => {
    const config = defaultConfig();
    config.email.enabled = true;
    const client = new EmailClient(
      config,
      new DirectHttpEmailTransport(async () => jsonResponse({
        kind: 'source_index_search',
        corpus_id: 'secure_local.whatsapp.messages',
        retrieval_source: 'local_index',
        hits: [],
        audit: {
          request_id: 'request-mismatch',
          retrieval_source: 'local_index',
          queries_attempted: 1,
          metadata_hits: 0,
          items_returned: 0,
          latency_ms: 1,
          raw_source_exposed: false,
          source_text_returned: false,
        },
        policy: {
          raw_source_exposed: false,
          source_text_returned: false,
          source_packets_exposed: false,
          local_only: true,
          trust_domain: 'secure_local',
        },
      })),
    );

    await expect(client.sourceIndexSearch({
      corpusId: 'internal.telegram.messages',
      query: 'connector store',
    })).rejects.toThrow('source index search returned a different corpus than requested');
  });

  test('source_index_search accepts configured connector-store corpora with matching safe policy', async () => {
    const config = defaultConfig();
    config.email.enabled = true;
    const requests: Request[] = [];
    const client = new EmailClient(
      config,
      new DirectHttpEmailTransport(async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        const body = await request.clone().json() as { corpus_id: string };
        const trustDomain = body.corpus_id.startsWith('secure_local.') ? 'secure_local' : 'internal';
        return jsonResponse({
          kind: 'source_index_search',
          corpus_id: body.corpus_id,
          retrieval_source: 'local_index',
          hits: [],
          audit: {
            request_id: 'request-connector-store',
            retrieval_source: 'local_index',
            queries_attempted: 1,
            metadata_hits: 0,
            items_returned: 0,
            latency_ms: 1,
            raw_source_exposed: false,
            source_text_returned: false,
          },
          policy: {
            raw_source_exposed: false,
            source_text_returned: false,
            source_packets_exposed: false,
            local_only: trustDomain === 'secure_local',
            trust_domain: trustDomain,
          },
        });
      }),
    );

    const internalTelegram = await client.sourceIndexSearch({
      corpusId: 'internal.telegram.messages',
      query: 'connector store',
    });
    const whatsApp = await client.sourceIndexSearch({
      corpusId: 'secure_local.whatsapp.messages',
      query: 'voice note',
    });

    expect(internalTelegram).toMatchObject({
      corpus_id: 'internal.telegram.messages',
      policy: { local_only: false, trust_domain: 'internal' },
    });
    expect(whatsApp).toMatchObject({
      corpus_id: 'secure_local.whatsapp.messages',
      policy: { local_only: true, trust_domain: 'secure_local' },
    });
    expect(await requests[0]?.json()).toMatchObject({ corpus_id: 'internal.telegram.messages' });
    expect(await requests[1]?.json()).toMatchObject({ corpus_id: 'secure_local.whatsapp.messages' });
  });

  test('source_index_search rejects configured corpora whose policy trust domain does not match', async () => {
    const config = defaultConfig();
    config.email.enabled = true;
    const client = new EmailClient(
      config,
      new DirectHttpEmailTransport(async () => jsonResponse({
        kind: 'source_index_search',
        corpus_id: 'internal.telegram.messages',
        retrieval_source: 'local_index',
        hits: [],
        audit: {
          request_id: 'request-bad-policy',
          retrieval_source: 'local_index',
          queries_attempted: 1,
          metadata_hits: 0,
          items_returned: 0,
          latency_ms: 1,
          raw_source_exposed: false,
          source_text_returned: false,
        },
        policy: {
          raw_source_exposed: false,
          source_text_returned: false,
          source_packets_exposed: false,
          local_only: true,
          trust_domain: 'secure_local',
        },
      })),
    );

    await expect(client.sourceIndexSearch({
      corpusId: 'internal.telegram.messages',
      query: 'connector store',
    })).rejects.toThrow('source index search policy must describe a local safe result');
  });

  test('source_index_sync and source_index_search call private source worker when gated', async () => {
    const config = defaultConfig();
    config.email.enabled = true;
    config.email.indexAdminDevEnabled = true;
    const requests: Request[] = [];
    const client = new EmailClient(
      config,
      new DirectHttpEmailTransport(async (input, init) => {
        requests.push(new Request(input, init));
        if (String(input).endsWith('/source/index/sync')) {
          return jsonResponse({
            sync_run_id: 'telegram-sync-1',
            status: 'completed',
            corpus_id: 'secure_local.telegram.protected.messages',
            provider: 'telegram',
            account: 'telegram.personal',
            messages_indexed: 1,
            policy: { raw_source_exposed: false, source_text_returned: false },
          });
        }
        return jsonResponse({
          kind: 'source_index_search',
          corpus_id: 'secure_local.telegram.protected.messages',
          retrieval_source: 'local_index',
          hits: [],
          audit: {
            request_id: 'request-1',
            retrieval_source: 'local_index',
            queries_attempted: 1,
            metadata_hits: 0,
            items_returned: 0,
            latency_ms: 1,
            raw_source_exposed: false,
            source_text_returned: false,
          },
          policy: {
            raw_source_exposed: false,
            source_text_returned: false,
            source_packets_exposed: false,
            local_only: true,
            trust_domain: 'secure_local',
          },
        });
      }),
    );

    const sync = await client.sourceIndexSync({
      corpusId: 'secure_local.telegram.messages',
      account: 'telegram.personal',
      chatScope: 'telegram.personal:chat:chat-porto',
      maxMessages: 5,
      providerCursor: 'offset_id:100',
    });
    const search = await client.sourceIndexSearch({
      corpusId: 'secure_local.telegram.messages',
      query: 'surface',
      account: 'telegram.personal',
      chatScope: 'telegram.personal:chat:chat-porto',
      trustDomain: 'secure_local',
      attachmentType: 'file',
      maxResults: 5,
    });

    expect(sync).toMatchObject({
      corpus_id: 'secure_local.telegram.protected.messages',
      policy: { raw_source_exposed: false, source_text_returned: false },
    });
    expect(search).toMatchObject({
      kind: 'source_index_search',
      corpus_id: 'secure_local.telegram.protected.messages',
      policy: { raw_source_exposed: false, source_text_returned: false },
    });
    expect(requests[0]?.url).toBe('http://127.0.0.1:8010/v1/source/index/sync');
    expect(await requests[0]?.json()).toEqual({
      corpus_id: 'secure_local.telegram.protected.messages',
      account: 'telegram.personal',
      chat_scope: 'telegram.personal:chat:chat-porto',
      max_messages: 5,
      provider_cursor: 'offset_id:100',
    });
    expect(requests[1]?.url).toBe('http://127.0.0.1:8010/v1/source/index/search');
    expect(await requests[1]?.json()).toEqual({
      query: 'surface',
      corpus_id: 'secure_local.telegram.protected.messages',
      account: 'telegram.personal',
      chat_scope: 'telegram.personal:chat:chat-porto',
      trust_domain: 'secure_local',
      attachment_type: 'file',
      max_results: 5,
    });
  });

  test('email_index_sync, email_index_embed, and email_index_search call private worker when gated', async () => {
    const config = defaultConfig();
    config.email.enabled = true;
    config.email.indexAdminDevEnabled = true;
    config.email.localPacketsDevEnabled = true;
    const requests: Request[] = [];
    const client = new EmailClient(
      config,
      new DirectHttpEmailTransport(async (input, init) => {
        requests.push(new Request(input, init));
        if (String(input).endsWith('/index/sync')) {
          return jsonResponse({
            sync_run_id: 'sync-1',
            status: 'completed',
            provider: 'gmail',
            account: 'person@example.com',
            source_scope: 'newer_than_days:7;max:5',
            items_seen: 1,
            items_indexed: 1,
            threads_indexed: 1,
            checkpoint_recorded: true,
            store_path: '/tmp/email.sqlite',
            gaps: [],
            policy: { raw_email_exposed: false, local_only: true },
          });
        }
        if (String(input).endsWith('/index/embed')) {
          return jsonResponse({
            semantic_run_id: 'semantic-run-1',
            status: 'completed',
            provider: 'gmail',
            account: 'person@example.com',
            model_id: 'local-embedding-model',
            embedding_provider: 'local-openai-compatible',
            embedding_dimension: 32,
            vector_backend: 'exact_scan',
            chunks_seen: 1,
            chunks_embedded: 1,
            chunks_skipped: 0,
            store_path: '/tmp/email.sqlite',
            policy: {
              raw_email_exposed: false,
              local_only: true,
              cloud_embedding_eligible: false,
              derived_private_data: true,
            },
          });
        }
        return jsonResponse({
          packet: {
            kind: 'email_source_packet',
            packet_id: 'packet-1',
            source: 'gmail',
            items: [{
              item_id: 'msg-1',
              thread_id: 'thread-1',
              sanitized_text: 'Sanitized appointment details.',
              provenance: {
                provider: 'gmail',
                account: 'person@example.com',
                message_id: 'msg-1',
                thread_id: 'thread-1',
                local_message_id: '1',
                chunk_ids: ['1'],
                sync_run_id: 'sync-1',
              },
            }],
          },
          audit: {
            request_id: 'request-1',
            retrieval_source: 'local_index',
            queries_attempted: 1,
            retrieval_mode: 'hybrid',
            requested_retrieval_mode: 'hybrid',
            keyword_candidates: 1,
            vector_candidates: 1,
            fused_candidates: 1,
            embedding_model_id: 'local-embedding-model',
            vector_backend: 'exact_scan',
            metadata_hits: 1,
            items_returned: 1,
            threads_returned: 1,
            latency_ms: 1,
            sanitized_reads_attempted: 0,
            sanitized_reads_succeeded: 0,
            truncated: false,
            local_packet: true,
            raw_email_exposed: false,
          },
          policy: {
            raw_email_exposed: false,
            local_only: true,
            requires_local_session: true,
          },
        });
      }),
    );

    await client.indexSync({ newerThanDays: 7, maxMessages: 5 });
    const embed = await client.indexEmbed({ account: 'person@example.com', modelId: 'local-embedding-model', force: true });
    const search = await client.indexSearch({
      query: 'school visit',
      retrievalMode: 'hybrid',
      label: 'INBOX',
      maxMessages: 5,
    });

    expect(requests[0]?.url).toBe('http://127.0.0.1:8010/v1/index/sync');
    expect(await requests[0]?.json()).toEqual({ newer_than_days: 7, max_messages: 5 });
    expect(requests[1]?.url).toBe('http://127.0.0.1:8010/v1/index/embed');
    expect(await requests[1]?.json()).toEqual({
      account: 'person@example.com',
      model_id: 'local-embedding-model',
      force: true,
    });
    expect(requests[2]?.url).toBe('http://127.0.0.1:8010/v1/index/search');
    expect(await requests[2]?.json()).toEqual({
      query: 'school visit',
      retrieval_mode: 'hybrid',
      label: 'INBOX',
      max_messages: 5,
    });
    expect(embed).toMatchObject({
      model_id: 'local-embedding-model',
      policy: { raw_email_exposed: false, cloud_embedding_eligible: false },
    });
    expect(search.packet.items[0]?.provenance.local_message_id).toBe('1');
    expect(search.audit.retrieval_source).toBe('local_index');
    expect(search.audit.retrieval_mode).toBe('hybrid');
    expect(search.audit.embedding_model_id).toBe('local-embedding-model');
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sourceAnswerPayload(audit: { self_heal?: unknown } = {}) {
  return {
    answer: 'Safe answer.',
    evidence: [],
    audit: {
      searched_corpora: ['internal.docs'],
      skipped_corpora: [],
      lane_audits: [],
      ...(audit.self_heal !== undefined ? { self_heal: audit.self_heal } : {}),
      answer_synthesis: {
        analyst_backend: 'local',
        private_context_used: false,
        secure_local_items_consulted: 0,
        internal_items_consulted: 0,
        raw_source_exposed: false,
      },
      latency_ms: 1,
      raw_source_exposed: false,
    },
    policy: {
      raw_source_exposed: false,
      source_packets_exposed: false,
      internal_content_exposed: false,
      secure_local_content_exposed: false,
      castor_safe_bridge: true,
    },
  };
}
