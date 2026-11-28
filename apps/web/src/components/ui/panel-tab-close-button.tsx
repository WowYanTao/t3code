import { X } from "lucide-react";
import type { ReactNode } from "react";
import { SharedTooltipTrigger } from "~/components/ui/shared-tooltip";
import { cn } from "~/lib/utils";

interface PanelTabCloseButtonProps {
  children?: ReactNode;
  label: string;
  onClick: () => void;
  tooltip?: string;
  active?: boolean;
}

export function PanelTabCloseButton({
  children,
  label,
  onClick,
  tooltip,
  active = false,
}: PanelTabCloseButtonProps) {
  const overlaysIcon = children !== undefined;
  const button = (
    <button
      type="button"
      className={cn(
        "cursor-pointer group/close relative flex size-4 shrink-0 items-center justify-center rounded-sm hover:bg-muted",
        !overlaysIcon &&
          (active
            ? "opacity-70 hover:opacity-100 group-hover/tab:opacity-100"
            : "opacity-0 group-hover/tab:opacity-100 focus-visible:opacity-100"),
      )}
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      {overlaysIcon ? (
        <>
          <span className="relative flex size-3 items-center justify-center group-hover/tab:hidden group-focus-visible/close:hidden">
            {children}
          </span>
          <X className="hidden size-3 group-hover/tab:block group-focus-visible/close:block" />
        </>
      ) : (
        <X className="size-3" />
      )}
    </button>
  );

  if (!tooltip) return button;

  return <SharedTooltipTrigger render={button} label={tooltip} />;
}
