export class VaultError extends Error {
  override readonly name: string = "VaultError";
}

export class LoopbackError extends VaultError {
  override readonly name = "LoopbackError";
}

export class KeychainError extends VaultError {
  override readonly name = "KeychainError";
}

export class GrantError extends VaultError {
  override readonly name = "GrantError";
}
