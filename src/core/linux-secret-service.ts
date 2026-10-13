/**
 * Gio speaks Secret Service without libsecret's implicit unlock/prompt helpers.
 * Values travel only over stdin/stdout and the private user bus, never argv.
 * Optional libsecret mode requires python3 with PyGObject (python3-gi on Debian,
 * python-gobject on Arch). File mode needs none of these.
 * The parent imposes a five-second SIGKILL deadline on the entire operation.
 */
export const LINUX_SECRET_SERVICE_HELPER = String.raw`
import json, sys
try:
    from gi.repository import Gio, GLib
    request = json.load(sys.stdin)
    import os
    address = os.environ.get('DBUS_SESSION_BUS_ADDRESS')
    bus = (Gio.DBusConnection.new_for_address_sync(address, Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION, None, None)
           if address else Gio.bus_get_sync(Gio.BusType.SESSION, None))
    service = 'org.freedesktop.secrets'
    base = '/org/freedesktop/secrets'
    iface = 'org.freedesktop.Secret.'
    def raw_call(path, interface, method, signature, args):
        params = GLib.Variant(signature, args) if signature else None
        return bus.call_sync(service, path, interface, method, params, None,
                             Gio.DBusCallFlags.NONE, 4500, None)
    def call(path, interface, method, signature, args):
        return raw_call(path, interface, method, signature, args).unpack()
    if request['action'] == 'bus':
        result = raw_call(request['path'], request['interface'], request['method'], request['signature'], request['args'])
        if request['method'] == 'Get':
            value = result.get_child_value(0).get_variant()
            response = {'type': value.get_type_string(), 'data': [value.unpack()]}
        else:
            response = {'type': result.get_type_string()[1:-1], 'data': result.unpack()}
        sys.stdout.write(json.dumps(response))
        sys.exit(0)
    def unlocked(path, kind):
        if call(path, 'org.freedesktop.DBus.Properties', 'Get', '(ss)', (iface + kind, 'Locked'))[0]:
            raise RuntimeError('IsLocked')
    collection = request['collection']
    unlocked(collection, 'Collection')
    action = request['action']
    if action == 'clear':
        # Delete only the parent-validated identity, never new attribute matches.
        items = request.get('items')
        if not isinstance(items, list) or len(items) != 1 or not isinstance(items[0], str) or not items[0].startswith(collection + '/'):
            raise RuntimeError('InvalidData')
        for item in items:
            unlocked(item, 'Item')
            prompt = call(item, iface + 'Item', 'Delete', None, ())[0]
            if prompt != '/':
                raise RuntimeError('IsLocked')
    else:
        items, locked = call(base, iface + 'Service', 'SearchItems', '(a{ss})', ({'application': 'olympus', 'key': request['key']},))
        if locked:
            raise RuntimeError('IsLocked')
        for item in items:
            unlocked(item, 'Item')
        if len(items) > 1:
            raise RuntimeError('InvalidData')
        if action == 'lookup' and not items:
            # It existed at preflight: disappearance is a failed read, not absent.
            raise RuntimeError('Unavailable')
        _, session = call(base, iface + 'Service', 'OpenSession', '(sv)', ('plain', GLib.Variant('s', '')))
        try:
            if action == 'lookup':
                result = call(items[0], iface + 'Item', 'GetSecret', '(o)', (session,))[0]
                sys.stdout.write(bytes(result[2]).decode('utf-8'))
            elif action == 'store':
                if any(not item.startswith(collection + '/') for item in items):
                    raise RuntimeError('InvalidData')
                props = {iface + 'Item.Label': GLib.Variant('s', 'Olympus ' + request['key']),
                         iface + 'Item.Attributes': GLib.Variant('a{ss}', {'application': 'olympus', 'key': request['key']})}
                secret = (session, [], list(request['value'].encode('utf-8')), 'text/plain; charset=utf8')
                _, prompt = call(collection, iface + 'Collection', 'CreateItem', '(a{sv}(oayays)b)', (props, secret, True))
                if prompt != '/':
                    raise RuntimeError('IsLocked')
            else:
                raise RuntimeError('InvalidData')
        finally:
            call(session, iface + 'Session', 'Close', None, ())
except Exception as error:
    # Never forward arbitrary provider text, which can contain secret material.
    text = str(error)
    if 'GLib' in globals() and isinstance(error, GLib.Error):
        text += ' ' + (Gio.DBusError.get_remote_error(error) or '')
    code = 'unavailable'
    if 'IsLocked' in text: code = 'locked'
    elif any(s in text for s in ('AccessDenied', 'PermissionDenied', 'Permission denied')): code = 'permission'
    elif any(s in text for s in ('TimedOut', 'NoReply', 'Timeout', 'timed out')): code = 'timeout'
    elif 'InvalidData' in text: code = 'corrupt'
    sys.stderr.write(code)
    sys.exit(1)
`;
