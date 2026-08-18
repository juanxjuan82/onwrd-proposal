// Minimal Vite import.meta.env typing (avoids a vite devDependency).
interface ImportMetaEnv {
  readonly BASE_URL: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
