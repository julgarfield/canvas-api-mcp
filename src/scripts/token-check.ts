/** Reports whether a token is configured and where from. Never prints it. */
import { createTokenProvider, keychainAccount, KEYCHAIN_SERVICE, loadConfig } from "../config.js";

const config = loadConfig();
const src = await createTokenProvider(config.origin).source().catch(() => null);
process.stdout.write(
  src
    ? `Token found (source: ${src}) for ${config.origin}.\n`
    : `No token found for ${config.origin}. Keychain item expected: service "${KEYCHAIN_SERVICE}", account "${keychainAccount(config.origin)}". Run: npm run token:setup\n`,
);
process.exitCode = src ? 0 : 1;
