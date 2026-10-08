function isArgonHash(hash) {
    return typeof hash === 'string' && hash.startsWith('$argon2');
}
  
function generateMD5(input) {
    const crypto = require('crypto');
    return crypto.createHash('md5').update(input).digest('hex');
}

module.exports = {
    isArgonHash,
    generateMD5
};
