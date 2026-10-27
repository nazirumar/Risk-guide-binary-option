import { cn } from "@/lib/utils";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";

/**
 * FormField — wraps a label + an input slot + an error/hint slot. The input
 * is passed as children so it can be any control (Input, Select, Textarea,
 * combobox, etc.). Keeps forms visually consistent across the app.
 */
export function FormField({
  label,
  htmlFor,
  error,
  hint,
  required,
  children,
  className,
}: {
  label: string;
  htmlFor: string;
  error?: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("grid gap-1.5", className)}>
      <Label htmlFor={htmlFor} className="text-sm font-medium leading-none">
        {label}
        {required && <span className="text-destructive ml-0.5">*</span>}
      </Label>
      {children}
      {hint && !error && <p className="text-xs text-muted-foreground">{hint}</p>}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Convenience: FormField that wraps a plain Input.
 */
export function FormInput({
  label,
  id,
  error,
  hint,
  required,
  className,
  ...inputProps
}: React.ComponentProps<typeof Input> & {
  label: string;
  id: string;
  error?: string;
  hint?: string;
  required?: boolean;
}) {
  return (
    <FormField
      label={label}
      htmlFor={id}
      error={error}
      hint={hint}
      required={required}
      className={className}
    >
      <Input id={id} {...inputProps} aria-invalid={!!error} />
    </FormField>
  );
}
