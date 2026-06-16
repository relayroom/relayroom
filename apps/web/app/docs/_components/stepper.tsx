import { cn } from "@/lib/utils";

const STEPS = {
  en: ["Create account", "Create project", "Add agents", "Main agent"],
  ko: ["계정 생성", "프로젝트 생성", "에이전트 추가", "메인 에이전트"],
} as const;

/**
 * The shared usage flow, shown at the top of every Usage page with the current
 * step highlighted (Create account -> Create project -> Add agents -> Main agent).
 * Used from the usage MDX pages: `<Stepper current={1} locale="en" />`.
 */
export function Stepper({
  current,
  locale = "en",
}: {
  current: number;
  locale?: "en" | "ko";
}) {
  const steps = STEPS[locale];
  return (
    <div className="not-prose my-7 flex flex-wrap items-center gap-x-1.5 gap-y-2 text-sm">
      {steps.map((label, i) => {
        const state = i < current ? "done" : i === current ? "active" : "todo";
        return (
          <div key={label} className="flex items-center gap-1.5">
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-3 py-1",
                state === "active" && "border-primary bg-primary font-medium text-primary-foreground",
                state === "done" && "border-border text-muted-foreground",
                state === "todo" && "border-border text-muted-foreground/60",
              )}
            >
              <span
                className={cn(
                  "inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-semibold",
                  state === "active" && "bg-primary-foreground/20",
                  state !== "active" && "bg-muted",
                )}
              >
                {state === "done" ? "✓" : i + 1}
              </span>
              {label}
            </span>
            {i < steps.length - 1 && (
              <span aria-hidden className="text-border">
                →
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
