"""Inherited only by the isolated test runner's Python fixture processes."""
import ipaddress
import socket


def _local(host):
    if host in (None, '', 'localhost'):
        return
    try:
        if ipaddress.ip_address(host).is_loopback:
            return
    except ValueError:
        pass
    raise OSError('Offline test refused non-loopback connection: ' + str(host))


_connect = socket.socket.connect
_connect_ex = socket.socket.connect_ex
_getaddrinfo = socket.getaddrinfo
_sendto = socket.socket.sendto


def connect(self, address):
    if self.family in (socket.AF_INET, socket.AF_INET6):
        _local(address[0])
    return _connect(self, address)


def connect_ex(self, address):
    if self.family in (socket.AF_INET, socket.AF_INET6):
        _local(address[0])
    return _connect_ex(self, address)


def getaddrinfo(host, *args, **kwargs):
    _local(host)
    return _getaddrinfo(host, *args, **kwargs)


socket.socket.connect = connect
socket.socket.connect_ex = connect_ex
socket.getaddrinfo = getaddrinfo


def sendto(self, data, *args):
    if self.family in (socket.AF_INET, socket.AF_INET6):
        _local(args[-1][0])
    return _sendto(self, data, *args)


socket.socket.sendto = sendto
if hasattr(socket.socket, 'sendmsg'):
    _sendmsg = socket.socket.sendmsg

    def sendmsg(self, buffers, ancdata=(), flags=0, address=None):
        if address is not None and self.family in (socket.AF_INET, socket.AF_INET6):
            _local(address[0])
        return _sendmsg(self, buffers, ancdata, flags, address)

    socket.socket.sendmsg = sendmsg


def guard_resolver(original):
    def guarded(host, *args):
        _local(host)
        return original(host, *args)
    return guarded


for _name in ('gethostbyname', 'gethostbyname_ex', 'gethostbyaddr'):
    setattr(socket, _name, guard_resolver(getattr(socket, _name)))
