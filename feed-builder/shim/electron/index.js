// En GitHub no hay Electron: la red usa fetch de Node.
module.exports = { net: { fetch: (...a) => fetch(...a) }, app: { getPath: () => require('os').tmpdir() } };
