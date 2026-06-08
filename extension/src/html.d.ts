// Lets TypeScript import .html files as strings (esbuild bundles them via the `text` loader).
declare module "*.html" {
  const content: string;
  export default content;
}
