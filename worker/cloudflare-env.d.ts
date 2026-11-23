interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(column?: string): Promise<T | null>;
  run<T = unknown>(): Promise<T>;
  all<T = unknown>(): Promise<T>;
  raw<T = unknown>(): Promise<T>;
}

interface D1Result<T = Record<string, unknown>> {
  success: boolean;
  results: T[];
  meta: Record<string, unknown>;
  error?: string;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
  dump(): Promise<ArrayBuffer>;
  batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec<T = unknown>(query: string): Promise<T>;
}

interface R2Object {
  body: ReadableStream;
  httpEtag: string;
  etag: string;
  key: string;
  size: number;
  uploaded: Date;
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
  writeHttpMetadata(headers: Headers): void;
}

interface R2Bucket {
  head(key: string): Promise<Omit<R2Object, "body" | "arrayBuffer" | "text" | "json"> | null>;
  get(key: string, options?: { onlyIf?: { etagMatches?: string } }): Promise<R2Object | null>;
  put(key: string, value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob, options?: {
    httpMetadata?: { contentType?: string };
    customMetadata?: Record<string, string>;
    onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string };
    sha256?: string | ArrayBuffer;
  }): Promise<R2Object | null>;
  delete(key: string | string[]): Promise<void>;
  list(options?: { prefix?: string; cursor?: string; limit?: number; include?: ("customMetadata" | "httpMetadata")[] }): Promise<{
    objects: Array<Omit<R2Object, "body" | "arrayBuffer" | "text" | "json">>;
    truncated: boolean;
    cursor?: string;
  }>;
}

interface ImagesBinding {
  input(stream: ReadableStream): {
    transform(options: Record<string, unknown>): {
      output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
    };
  };
}

declare module "cloudflare:workers" {
  export const env: {
    DB: D1Database;
    BUCKET: R2Bucket;
    IMAGES?: ImagesBinding;
    TMDB_API_KEY?: string;
    BANGUMI_TOKEN_ENCRYPTION_KEY?: string;
    YUEXIAJI_CREDENTIALS_ENCRYPTION_KEY?: string;
    ANIMESCHEDULE_TOKEN?: string;
  };
}
