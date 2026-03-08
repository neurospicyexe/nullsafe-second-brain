export interface VaultWriteOptions {
  path: string;       // relative to vault root
  content: string;
  overwrite?: boolean;
}

export interface VaultAdapter {
  write(options: VaultWriteOptions): Promise<void>;
  read(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  list(dirPath?: string): Promise<string[]>;
}
