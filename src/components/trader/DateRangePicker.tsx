"use client";

import { useState } from "react";
import { format } from "date-fns";
import { Calendar as CalendarIcon } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { DateRange } from "react-day-picker";

/**
 * DateRangePicker — wraps shadcn Calendar in a popover with a button trigger.
 * Returns a DateRange (from/to). Used in analytics + reports (Phase 9+).
 */
export function DateRangePicker({
  value,
  onChange,
  className,
}: {
  value?: DateRange;
  onChange: (range: DateRange | undefined) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className={cn("justify-start text-left font-normal h-11", className)}
          aria-label="Pick a date range"
        >
          <CalendarIcon className="size-4 mr-2" aria-hidden="true" />
          {value?.from ? (
            value.to ? (
              <>
                {format(value.from, "LLL dd, y")} – {format(value.to, "LLL dd, y")}
              </>
            ) : (
              format(value.from, "LLL dd, y")
            )
          ) : (
            <span className="text-muted-foreground">Pick a date range</span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="range"
          selected={value}
          onSelect={(r) => {
            onChange(r);
            if (r?.to) setOpen(false);
          }}
          numberOfMonths={2}
          initialFocus
        />
      </PopoverContent>
    </Popover>
  );
}
