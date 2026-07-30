import { Activity, Bot, Boxes, Home } from "lucide-react";
import type { ComponentProps } from "react";
import {
  Link as RouterLink,
  NavLink as RouterNavLink,
  useSearchParams,
} from "react-router-dom";

export const pathWithFilters = (
  path: string,
  current: URLSearchParams
): string => {
  const [pathname = "/", query = ""] = path.split("?");
  const next = new URLSearchParams(query);
  const devices = current.get("devices");
  if (devices) {
    next.set("devices", devices);
  }
  const agents = current.get("agents");
  if (agents && pathname.startsWith("/sessions")) {
    next.set("agents", agents);
  }
  if (pathname === "/") {
    const range = current.get("range");
    if (range) {
      next.set("range", range);
    }
  }
  const suffix = next.toString();
  return `${pathname}${suffix ? `?${suffix}` : ""}`;
};

export const Link = (props: ComponentProps<typeof RouterLink>) => {
  const [searchParams] = useSearchParams();
  const to =
    typeof props.to === "string"
      ? pathWithFilters(props.to, searchParams)
      : props.to;
  return <RouterLink {...props} to={to} />;
};

export const NavLink = (props: ComponentProps<typeof RouterNavLink>) => {
  const [searchParams] = useSearchParams();
  const to =
    typeof props.to === "string"
      ? pathWithFilters(props.to, searchParams)
      : props.to;
  return <RouterNavLink {...props} to={to} />;
};

export const NAV_ITEMS = [
  { icon: Home, label: "Overview", to: "/" },
  { icon: Bot, label: "Agents", to: "/agents" },
  { icon: Boxes, label: "Projects", to: "/projects" },
  { icon: Activity, label: "Sessions", to: "/sessions" },
] as const;
