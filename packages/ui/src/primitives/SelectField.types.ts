export interface SelectOption<Value extends string = string> {
  value: Value;
  label: string;
}

export interface SelectFieldProps<Value extends string = string> {
  label: string;
  value: Value;
  options: readonly SelectOption<Value>[];
  onChange: (value: Value) => void;
  disabled?: boolean;
  error?: string;
  hint?: string;
  testID?: string;
}
