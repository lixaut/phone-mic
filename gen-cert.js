const forge = require('node-forge');
const { writeFileSync, mkdirSync, existsSync } = require('fs');
const { join } = require('path');
const os = require('os');

const CERT_DIR = join(__dirname, 'cert');

if (!existsSync(CERT_DIR)) {
  mkdirSync(CERT_DIR, { recursive: true });
}

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

const ip = getLocalIP();
console.log('Local IP: ' + ip);

const keys = forge.pki.rsa.generateKeyPair(2048);
const cert = forge.pki.createCertificate();

cert.publicKey = keys.publicKey;
cert.serialNumber = '01';
cert.validity.notBefore = new Date();
cert.validity.notAfter = new Date();
cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);

const attrs = [{ name: 'commonName', value: ip }];
cert.setSubject(attrs);
cert.setIssuer([{ name: 'commonName', value: 'PhoneMic Self-Signed' }]);

cert.setExtensions([
  {
    name: 'subjectAltName',
    altNames: [
      { type: 7, ip: ip },
      { type: 2, value: 'localhost' },
    ],
  },
]);

cert.sign(keys.privateKey, forge.md.sha256.create());

const certPem = forge.pki.certificateToPem(cert);
const keyPem = forge.pki.privateKeyToPem(keys.privateKey);

writeFileSync(join(CERT_DIR, 'cert.pem'), certPem);
writeFileSync(join(CERT_DIR, 'key.pem'), keyPem);

console.log('Certificate generated for ' + ip);
console.log('Files: cert/cert.pem, cert/key.pem');
console.log('\nOn iPhone, open: https://' + ip + ':3000');
console.log('Accept the certificate warning to continue.');
