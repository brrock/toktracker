import { RotateCcw, Sparkles } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { useAppearance } from "@/components/theme-provider";
import { Button } from "@/components/ui/button";
import { ONBOARDING_PATH } from "@/lib/onboarding";

import {
  AccentPicker,
  FontPicker,
  ModePicker,
  DetailPickers,
  SurfacePicker,
} from "./appearance-controls";
import { AppearancePreview } from "./appearance-preview";

const Section = ({
  children,
  description,
  title,
}: {
  children: React.ReactNode;
  description: string;
  title: string;
}) => (
  <div className="surface-card p-5">
    <h3 className="font-medium">{title}</h3>
    <p className="mt-0.5 mb-4 text-sm text-muted-foreground">{description}</p>
    {children}
  </div>
);

export const AppearanceSettings = () => {
  const navigate = useNavigate();
  const { appearance, resetAppearance, updateAppearance } = useAppearance();
  return (
    <section className="grid max-w-6xl gap-8 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="space-y-4">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight">
              Appearance
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Make TokTracker feel like yours. Preferences are saved in this
              browser.
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => navigate(ONBOARDING_PATH)}>
              <Sparkles />
              Replay onboarding
            </Button>
            <Button variant="outline" onClick={resetAppearance}>
              <RotateCcw />
              Reset
            </Button>
          </div>
        </div>
        <Section
          title="Mode"
          description="Follow your system or pin light or dark. Press D anywhere to flip."
        >
          <ModePicker />
        </Section>
        <Section
          title="Accent colour"
          description="Tints buttons, highlights and every chart."
        >
          <AccentPicker />
        </Section>
        <Section
          title="Typeface"
          description="Headings and body text across the dashboard."
        >
          <FontPicker />
        </Section>
        <Section
          title="Surface"
          description="The tone of backgrounds, cards and borders."
        >
          <SurfacePicker />
        </Section>
        <Section
          title="Shape & feel"
          description="Corner rounding, information density and the backdrop behind pages."
        >
          <DetailPickers />
        </Section>
        <Section title="Greeting" description="Shown on the overview page.">
          <input
            aria-label="Display name"
            className="h-9 w-full max-w-xs rounded-lg border bg-card px-3 text-sm outline-none transition focus:border-primary focus:ring-3 focus:ring-primary/20"
            maxLength={48}
            placeholder="Your name"
            value={appearance.displayName}
            onChange={(event) =>
              updateAppearance({ displayName: event.target.value })
            }
          />
        </Section>
      </div>
      <div className="hidden xl:block">
        <div className="sticky top-24">
          <p className="mb-3 text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
            Live preview
          </p>
          <AppearancePreview />
        </div>
      </div>
    </section>
  );
};
