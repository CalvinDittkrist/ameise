import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

// cn joins class names and lets a later Tailwind class override an earlier one of the same kind.
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
