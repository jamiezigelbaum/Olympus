# Isolated test service. No real user bus or credentials.
import json, sys, os
from gi.repository import Gio, GLib
root, state, ready = sys.argv[1:]
base = '/org/freedesktop/secrets'
collection = base + '/collection/login'
item = collection + '/fixture'
session = base + '/session/test'
prefix = 'org.freedesktop.Secret.'
values = {}
xml = '''<node>
<interface name="org.freedesktop.Secret.Service">
<method name="ReadAlias"><arg type="s" direction="in"/><arg type="o" direction="out"/></method>
<method name="SearchItems"><arg type="a{ss}" direction="in"/><arg type="ao" direction="out"/><arg type="ao" direction="out"/></method>
<method name="OpenSession"><arg type="s" direction="in"/><arg type="v" direction="in"/><arg type="v" direction="out"/><arg type="o" direction="out"/></method>
<method name="Unlock"><arg type="ao" direction="in"/><arg type="ao" direction="out"/><arg type="o" direction="out"/></method>
</interface>
<interface name="org.freedesktop.Secret.Collection">
<property name="Locked" type="b" access="read"/>
<method name="CreateItem"><arg type="a{sv}" direction="in"/><arg type="(oayays)" direction="in"/><arg type="b" direction="in"/><arg type="o" direction="out"/><arg type="o" direction="out"/></method>
</interface>
<interface name="org.freedesktop.Secret.Item">
<property name="Locked" type="b" access="read"/><property name="Attributes" type="a{ss}" access="read"/>
<method name="GetSecret"><arg type="o" direction="in"/><arg type="(oayays)" direction="out"/></method>
<method name="Delete"><arg type="o" direction="out"/></method>
</interface>
<interface name="org.freedesktop.Secret.Session"><method name="Close"/></interface>
</node>'''
node = Gio.DBusNodeInfo.new_for_xml(xml)
bus = Gio.DBusConnection.new_for_address_sync(os.environ['DBUS_SESSION_BUS_ADDRESS'], Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION, None, None)
def mode():
    with open(state) as f: return json.load(f)
def method(conn, sender, path, interface, name, params, invocation):
    m = mode()
    with open(root + '/calls', 'a') as f: f.write(name + '\n')
    if m.get('failure'):
        invocation.return_dbus_error('org.freedesktop.DBus.Error.AccessDenied', 'fixture denied'); return
    if name == 'Unlock':
        invocation.return_dbus_error('org.freedesktop.DBus.Error.Failed', 'must never unlock'); return
    args = params.unpack()
    if name == 'ReadAlias': result = GLib.Variant('(o)', (collection,))
    elif name == 'SearchItems':
        matches = [item] if values and (not args[0].get('key') or args[0]['key'] in values) else []
        result = GLib.Variant('(aoao)', (matches, []))
    elif name == 'OpenSession': result = GLib.Variant('(vo)', (GLib.Variant('s', ''), session))
    elif name == 'CreateItem':
        if m.get('race_locked'):
            invocation.return_dbus_error('org.freedesktop.Secret.Error.IsLocked', 'locked during access'); return
        attrs = args[0][prefix + 'Item.Attributes']
        values[attrs['key']] = bytes(args[1][2]); result = GLib.Variant('(oo)', (item, '/'))
    elif name == 'GetSecret': result = GLib.Variant('((oayays))', ((session, [], list(next(iter(values.values()))), 'text/plain'),))
    elif name == 'Delete':
        if m.get('cleanup_failure'):
            invocation.return_dbus_error('org.freedesktop.DBus.Error.AccessDenied', 'fixture denied'); return
        values.clear(); result = GLib.Variant('(o)', ('/',))
    elif name == 'Close': result = GLib.Variant('()', ())
    else: raise RuntimeError(name)
    invocation.return_value(result)
def prop(conn, sender, path, interface, name):
    if name == 'Locked': return GLib.Variant('b', mode().get('locked', False))
    return GLib.Variant('a{ss}', {'application': 'olympus', 'key': next(iter(values))})
for path, interface in [(base, 'Service'), (collection, 'Collection'), (item, 'Item'), (session, 'Session')]:
    bus.register_object(path, node.lookup_interface(prefix + interface), method, prop, None)
result = bus.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'RequestName', GLib.Variant('(su)', ('org.freedesktop.secrets', 0)), None, Gio.DBusCallFlags.NONE, 2000, None)
assert result.unpack()[0] == 1
open(ready, 'w').close()
GLib.MainLoop().run()
