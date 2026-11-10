import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyAddress, hostnameVerdict, isBlockedPort, parseIPv6 } from "./addresses.ts";

const BLOCKED_V4 = [
  "0.0.0.0", "0.1.2.3", "10.0.0.1", "10.255.255.255", "100.64.0.1", "100.127.255.255", "127.0.0.1", "127.1.2.3", "169.254.0.1", "169.254.169.254", "169.254.170.2",
  "172.16.0.1", "172.31.255.255", "192.0.0.1", "192.0.0.192", "192.0.2.1", "192.88.99.1", "192.168.0.1", "192.168.255.255", "198.18.0.1", "198.19.255.255", "198.51.100.1",
  "203.0.113.1", "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255", "168.63.129.16", "100.100.100.200",
];
const ALLOWED_V4 = ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.15.255.255", "172.32.0.1", "100.63.255.255", "100.128.0.1", "192.169.0.1", "198.20.0.1", "223.255.255.255", "11.0.0.1"];

const BLOCKED_V6 = [
  "::", "::1", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1", "::ffff:7f00:1", "0:0:0:0:0:ffff:7f00:1", "::ffff:10.0.0.1", "::ffff:a9fe:a9fe", "::ffff:192.168.1.1",
  "64:ff9b::7f00:1", "64:ff9b::a00:1", "64:ff9b::10.0.0.1", "64:ff9b::a9fe:a9fe", "64:ff9b:1::1", "fc00::1", "fd12:3456::1", "fd00:ec2::254", "fe80::1", "febf::1",
  "fec0::1", "ff02::1", "ff00::", "2001:db8::1", "2001::1", "2001:1::1", "2002:7f00:1::1", "2002:0a00:0001::1", "2002:a9fe:a9fe::1", "100::1", "::a00:1", "::ffff:0:7f00:1",
  "3fff::1", "5f00::1",
];
const ALLOWED_V6 = ["2606:4700:4700::1111", "2001:4860:4860::8888", "64:ff9b::808:808", "::ffff:8.8.8.8", "2a00:1450:4001:81b::200e", "2002:0808:0808::1"];

test("every blocked IPv4 range is refused", () => {
  for (const ip of BLOCKED_V4) assert.equal(classifyAddress(ip).allowed, false, ip);
});

test("ordinary public IPv4 addresses are allowed", () => {
  for (const ip of ALLOWED_V4) assert.equal(classifyAddress(ip).allowed, true, ip);
});

test("every blocked IPv6 form is refused, including embedded IPv4", () => {
  for (const ip of BLOCKED_V6) assert.equal(classifyAddress(ip).allowed, false, ip);
});

test("ordinary public IPv6 and public embedded IPv4 are allowed", () => {
  for (const ip of ALLOWED_V6) assert.equal(classifyAddress(ip).allowed, true, ip);
});

test("things that are not clean IP literals are refused", () => {
  for (const bad of ["", "localhost", "example.com", "1.2.3", "1.2.3.4.5", "999.1.1.1", "fe80::1%eth0", "::g", "1::2::3", "08.0.0.1"]) {
    assert.equal(classifyAddress(bad).allowed, false, bad);
  }
});

test("IPv6 parser expands compressed and dotted forms", () => {
  assert.deepEqual([...parseIPv6("::1")!].slice(12), [0, 0, 0, 1]);
  assert.deepEqual([...parseIPv6("::ffff:1.2.3.4")!].slice(10), [0xff, 0xff, 1, 2, 3, 4]);
  assert.deepEqual([...parseIPv6("1:2:3:4:5:6:7:8")!], [0, 1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 0, 7, 0, 8]);
  assert.equal(parseIPv6("1:2:3:4:5:6:7:8:9"), null);
  assert.equal(parseIPv6(":::"), null);
});

test("service ports for non-web protocols are blocked", () => {
  for (const port of [22, 25, 53, 110, 143, 445, 3306, 5432, 6379, 9200, 11211, 27017, 2375]) assert.equal(isBlockedPort(port), true, String(port));
  for (const port of [80, 443, 8080, 8443, 3000, 8000, 8888]) assert.equal(isBlockedPort(port), false, String(port));
  assert.equal(isBlockedPort(0), true);
  assert.equal(isBlockedPort(70000), true);
});

test("internal-looking host names are refused before DNS", () => {
  for (const host of ["localhost", "foo.localhost", "router.local", "metadata.google.internal", "freshrss", "printer.lan", "host.home.arpa", "intranet", "x.corp", ""]) {
    assert.equal(hostnameVerdict(host).ok, false, host);
  }
  for (const host of ["example.com", "www.example.co.uk", "xn--bcher-kva.example", "[2606:4700:4700::1111]", "8.8.8.8"]) {
    assert.equal(hostnameVerdict(host).ok, true, host);
  }
});
