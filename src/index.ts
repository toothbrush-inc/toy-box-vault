export { FileConnectionStore, connectionsPath } from "./connections.js";
export { KeychainError, LoopbackError, VaultError } from "./errors.js";
export { FileSecretStore, secretsPath } from "./file-secrets.js";
export {
  DEFAULT_KEYCHAIN_SERVICE,
  DEFAULT_VAULT_HOME,
  defaultVaultHome,
  resolveVaultHome,
} from "./home.js";
export {
  KeychainSecretStore,
  type CommandResult,
  type CommandRunner,
  type KeychainSecretStoreOptions,
} from "./keychain.js";
export {
  ApiKeyLoopback,
  type ApiKeyLoopbackOptions,
  type ApiKeyLoopbackPage,
} from "./apikey-loopback.js";
export { LoopbackServer, type LoopbackServerOptions } from "./loopback.js";
export {
  connectionId,
  maskSecret,
  type ConnectionKind,
  type ConnectionRecord,
  type ConnectionStatus,
  type ConnectionStore,
  type ConnectionView,
  type PutSecretInput,
  type SecretOrigin,
  type SecretStore,
} from "./types.js";
export { openVault, Vault, type OpenVaultOptions, type SecretBackend } from "./vault.js";
