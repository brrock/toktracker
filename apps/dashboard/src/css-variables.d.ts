import "react";

declare module "react" {
  // Allow CSS custom properties in `style`, the only inline styles the
  // design-system lint rules permit. This must stay an interface so it merges
  // with React's own CSSProperties.
  interface CSSProperties {
    // oxlint-disable-next-line typescript/consistent-indexed-object-style -- a Record alias cannot merge
    [property: `--${string}`]: number | string | undefined;
  }
}
