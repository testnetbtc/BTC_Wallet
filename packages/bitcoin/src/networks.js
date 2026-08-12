// Network config for Olesia/Chainwatch. testnet3 and testnet4 share address
// params (tb prefix, same version bytes) — only the chain (and thus the API) and
// explorer differ. Esplora-compatible APIs (mempool.space) are used for UTXO
// fetch + broadcast until we wire this to the local node.
import * as btc from '@scure/btc-signer';

// BIP-32 extended-key version bytes. Mainnet -> xpub/xprv, all test networks ->
// tpub/tprv. @scure/bip32's HDKey defaults to mainnet bytes, so testnet keys must
// be derived with these explicitly or they wrongly serialise as xpub.
const BIP32 = {
  main: { private: 0x0488ade4, public: 0x0488b21e }, // xprv / xpub
  test: { private: 0x04358394, public: 0x043587cf }, // tprv / tpub
};

export const NETWORKS = {
  mainnet:  { coin: 0, btc: btc.NETWORK,      bip32: BIP32.main, esplora: 'https://mempool.space/api',          explorer: 'https://mempool.space/tx/' },
  testnet3: { coin: 1, btc: btc.TEST_NETWORK, bip32: BIP32.test, esplora: 'https://mempool.space/testnet/api',  explorer: 'https://mempool.space/testnet/tx/' },
  testnet4: { coin: 1, btc: btc.TEST_NETWORK, bip32: BIP32.test, esplora: 'https://mempool.space/testnet4/api', explorer: 'https://mempool.space/testnet4/tx/' },
  // Signet: same address params as testnet (coin type 1, tb1…), separate chain, but
  // with regular ~10-min blocks — the best network for learning and for a faucet.
  signet:   { coin: 1, btc: btc.TEST_NETWORK, bip32: BIP32.test, esplora: 'https://mempool.space/signet/api',   explorer: 'https://mempool.space/signet/tx/' },
};

export function net(name) {
  const n = NETWORKS[name];
  if (!n) throw new Error(`unknown network: ${name} (use mainnet|testnet3|testnet4)`);
  return n;
}
