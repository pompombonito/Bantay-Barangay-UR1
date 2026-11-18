declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    SESSION_SECRET?: string;
    DESKTOP_TOKEN?: string;
    ACCOUNT_CREDENTIALS_JSON?: string;
  }
}
