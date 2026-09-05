"use client";

import { useEffect, useState } from "react";

type FormattedDateTime = {
  value: string | number;
  label: string;
};

export function useLocalizedDateTime(value: string | number | null | undefined): string {
  const [formatted, setFormatted] = useState<FormattedDateTime | null>(null);

  useEffect(() => {
    if (value === null || value === undefined) return;
    setFormatted({ value, label: new Date(value).toLocaleString() });
  }, [value]);

  return formatted && formatted.value === value ? formatted.label : "";
}
