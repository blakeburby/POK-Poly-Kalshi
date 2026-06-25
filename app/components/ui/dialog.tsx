"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

const Overlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-50 bg-black/55 backdrop-blur-[2px]",
      "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className,
    )}
    {...props}
  />
));
Overlay.displayName = "DialogOverlay";

/** Centered modal (command palette). */
export const CenterContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { title?: string }
>(({ className, children, title, ...props }, ref) => (
  <DialogPrimitive.Portal>
    <Overlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        "fixed left-1/2 top-[16%] z-50 w-[92vw] max-w-[560px] -translate-x-1/2 overflow-hidden rounded-lg border border-line-strong bg-surface shadow-2xl outline-none",
        "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:duration-150",
        className,
      )}
      {...props}
    >
      {title ? <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title> : null}
      {children}
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
));
CenterContent.displayName = "CenterContent";

/** Right-side sheet (trade detail drawer). */
export const SheetContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { title?: string }
>(({ className, children, title, ...props }, ref) => (
  <DialogPrimitive.Portal>
    <Overlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        "fixed inset-y-0 right-0 z-50 flex w-full max-w-[640px] flex-col border-l border-line-strong bg-surface",
        "shadow-2xl outline-none",
        "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right data-[state=open]:duration-200",
        className,
      )}
      {...props}
    >
      {title ? <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title> : null}
      <DialogPrimitive.Close className="absolute right-3 top-3 z-10 rounded-sm p-1 text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg">
        <X className="size-4" />
      </DialogPrimitive.Close>
      {children}
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
));
SheetContent.displayName = "SheetContent";

/** Bottom sheet (mobile). Slides up; capped height with internal scroll. */
export const BottomSheetContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { title?: string }
>(({ className, children, title, ...props }, ref) => (
  <DialogPrimitive.Portal>
    <Overlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        "fixed inset-x-0 bottom-0 z-50 flex max-h-[85dvh] flex-col rounded-t-xl border-t border-line-strong bg-surface",
        "shadow-2xl outline-none",
        "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom data-[state=open]:duration-200",
        className,
      )}
      {...props}
    >
      {title ? <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title> : null}
      <div className="flex items-center justify-center pt-2">
        <span className="h-1 w-9 rounded-full bg-line-strong" />
      </div>
      <DialogPrimitive.Close className="absolute right-3 top-3 z-10 rounded-sm p-1 text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg">
        <X className="size-4" />
      </DialogPrimitive.Close>
      <div className="min-h-0 overflow-y-auto" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
        {children}
      </div>
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
));
BottomSheetContent.displayName = "BottomSheetContent";
