import { Bot, Boxes, Cpu } from "lucide-react";

const AGENT_LOGOS = {
  claude: "/agent-logos/client-claude.jpg",
  codex: "/agent-logos/client-openai.jpg",
  copilot: "/agent-logos/client-copilot.jpg",
  hermes: "/agent-logos/client-hermes.png",
  opencode: "/agent-logos/client-opencode.png",
  pi: "/agent-logos/client-pi.png",
} satisfies Record<string, string>;

export const AgentLogo = ({
  name,
  size = "size-6",
}: {
  name: string;
  size?: string;
}) => {
  const source = Object.entries(AGENT_LOGOS).find(
    ([agent]) => agent === name.toLowerCase()
  )?.[1];
  return source ? (
    <img src={source} alt="" className={`${size} rounded object-cover`} />
  ) : (
    <span
      className={`grid ${size} place-items-center rounded bg-primary/10 text-primary`}
    >
      <Bot className="size-1/2" />
    </span>
  );
};

export const BreakdownIcon = ({
  kind,
  name,
}: {
  kind: "agent" | "model" | "project";
  name: string;
}) => {
  if (kind === "agent") {
    return <AgentLogo name={name} size="size-5" />;
  }
  if (kind === "project") {
    return <Boxes className="size-4 text-primary" />;
  }
  return <Cpu className="size-4 text-primary" />;
};

export const Card = ({ children }: { children: React.ReactNode }) => (
  <div className="rounded-lg border bg-card p-4 text-card-foreground">
    {children}
  </div>
);

export const EmptyState = ({ children }: { children: React.ReactNode }) => (
  <div className="rounded-md border border-dashed py-14 text-center text-sm text-muted-foreground">
    {children}
  </div>
);

export const Stat = ({
  icon,
  label,
  note,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  note: string;
  value: string;
}) => (
  <Card>
    <div className="flex items-center justify-between">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="grid size-8 place-items-center rounded-md bg-primary/10 text-primary [&>svg]:size-4">
        {icon}
      </span>
    </div>
    <div className="mt-5 truncate text-xl font-semibold tracking-tight">
      {value}
    </div>
    <p className="mt-1 text-xs text-muted-foreground">{note}</p>
  </Card>
);

export const Metric = ({ label, value }: { label: string; value: string }) => (
  <div>
    <div className="font-semibold">{value}</div>
    <div className="text-xs text-muted-foreground">{label}</div>
  </div>
);
