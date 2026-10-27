"use client";

import { useState } from "react";
import { Check, ChevronsUpDown, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { COMMON_ASSETS, ASSET_CATEGORIES, searchAssets, type AssetDef } from "@/lib/assets";

/**
 * AssetCombobox — searchable combobox of common FX/crypto/commodity/index
 * assets + OTC pairs. Free-text input always allowed — the user's typed
 * value becomes the selected asset even if it's not in the suggestion list
 * (PROJECT_RULES.md Phase 5: "free text allowed").
 */
export function AssetCombobox({
  value,
  onChange,
  disabled,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  // Show all categories by default, filtered when typing.
  const matches = searchAssets(query, 100);
  const grouped = ASSET_CATEGORIES.map((cat) => ({
    category: cat,
    items: matches.filter((a) => a.category === cat),
  })).filter((g) => g.items.length > 0);

  // The "use this exact value" free-text option — always shown when the
  // user has typed something that isn't an exact match.
  const showFreeTextOption =
    query.length > 0 && !COMMON_ASSETS.some((a) => a.symbol.toLowerCase() === query.toLowerCase());

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn("w-full justify-between font-normal", !value && "text-muted-foreground")}
          disabled={disabled}
        >
          <span className="truncate">{value || "Search or type an asset…"}</span>
          <ChevronsUpDown className="size-4 shrink-0 opacity-50" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[320px] p-0" align="start">
        <Command shouldFilter={false}>
          <div className="flex items-center border-b border-border px-3">
            <Search className="size-4 shrink-0 opacity-50" aria-hidden="true" />
            <CommandInput
              placeholder="Type EUR/USD, BTC, OTC…"
              value={query}
              onValueChange={setQuery}
              className="flex-1"
            />
          </div>
          <CommandList className="max-h-64">
            <CommandEmpty>No matching assets — type your own and use it below.</CommandEmpty>
            {showFreeTextOption && (
              <CommandGroup heading="Use this exact value">
                <CommandItem
                  value={`freetext-${query}`}
                  onSelect={() => {
                    onChange(query.toUpperCase());
                    setOpen(false);
                  }}
                >
                  <Check
                    className={cn(
                      "size-4",
                      value === query.toUpperCase() ? "opacity-100" : "opacity-0",
                    )}
                    aria-hidden="true"
                  />
                  <span className="font-mono">{query}</span>
                </CommandItem>
              </CommandGroup>
            )}
            {grouped.map((group) => (
              <CommandGroup key={group.category} heading={group.category}>
                {group.items.map((a: AssetDef) => (
                  <CommandItem
                    key={a.symbol}
                    value={a.symbol}
                    onSelect={() => {
                      onChange(a.symbol);
                      setOpen(false);
                    }}
                  >
                    <Check
                      className={cn("size-4", value === a.symbol ? "opacity-100" : "opacity-0")}
                      aria-hidden="true"
                    />
                    <span className="font-mono text-sm">{a.symbol}</span>
                    <span className="ml-2 text-xs text-muted-foreground truncate">
                      {a.label.replace(`${a.symbol} — `, "")}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
