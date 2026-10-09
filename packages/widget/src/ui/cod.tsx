import type { DeliveryPrefill, UiPart } from "@ace/agent";
import { useId, useState } from "preact/hooks";
import { formatMoney } from "../money";
import type { RunAction } from "./cards";

type SummaryPart = Extract<UiPart, { type: "cod_summary" }>;

const EMPTY: DeliveryPrefill = { name: "", phone: "", line1: "", city: "" };

/** Only non-empty optional fields are sent; the engine validates everything again. */
function codInput(values: DeliveryPrefill, countryCode: string): Record<string, unknown> {
  const optional = (value: string | undefined) => (value?.trim() ? value.trim() : undefined);
  const address: Record<string, unknown> = { line1: values.line1, city: values.city, countryCode };
  if (optional(values.line2)) address.line2 = optional(values.line2);
  if (optional(values.district)) address.district = optional(values.district);
  if (optional(values.postalCode)) address.postalCode = optional(values.postalCode);
  const input: Record<string, unknown> = { name: values.name, phone: values.phone, address };
  if (optional(values.email)) input.email = optional(values.email);
  if (optional(values.note)) input.note = optional(values.note);
  return input;
}

interface FieldProps {
  label: string;
  value: string | undefined;
  autocomplete: string;
  required?: boolean;
  type?: "text" | "tel" | "email";
  maxLength: number;
  onInput: (value: string) => void;
}

function inputProps(props: FieldProps, id: string) {
  return {
    id,
    value: props.value ?? "",
    autocomplete: props.autocomplete,
    required: props.required,
    maxLength: props.maxLength,
    onInput: (event: Event) => props.onInput((event.target as HTMLInputElement).value),
  };
}

function Field(props: FieldProps) {
  const id = useId();
  return (
    <label class="field" htmlFor={id}>
      <span>
        {props.label}
        {props.required ? "" : " (optional)"}
      </span>
      {/* One literal type per branch: Preact's accessible-input typings key the allowed props on it. */}
      {props.type === "tel" ? (
        <input type="tel" {...inputProps(props, id)} />
      ) : props.type === "email" ? (
        <input type="email" {...inputProps(props, id)} />
      ) : (
        <input type="text" {...inputProps(props, id)} />
      )}
    </label>
  );
}

/** Cash on delivery, step 1: the shopper types their own details. The model never sees or fills this form. */
export function DeliveryForm(props: {
  countryCode: string;
  cities: string[] | null;
  prefill: DeliveryPrefill | null;
  busy: boolean;
  onAction: RunAction;
}) {
  const [values, setValues] = useState<DeliveryPrefill>(props.prefill ?? EMPTY);
  const set = (key: keyof DeliveryPrefill) => (value: string) =>
    setValues((current) => ({ ...current, [key]: value }));
  const complete = [values.name, values.phone, values.line1, values.city].every(
    (value) => value.trim() !== "",
  );
  return (
    <form
      class="card cod-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (complete && !props.busy) props.onAction("cod_quote", codInput(values, props.countryCode));
      }}
    >
      <fieldset>
        <legend>Delivery details (cash on delivery)</legend>
        <Field
          label="Full name"
          value={values.name}
          autocomplete="name"
          required
          maxLength={120}
          onInput={set("name")}
        />
        <Field
          label="Phone"
          type="tel"
          value={values.phone}
          autocomplete="tel"
          required
          maxLength={20}
          onInput={set("phone")}
        />
        <Field
          label="Address"
          value={values.line1}
          autocomplete="address-line1"
          required
          maxLength={200}
          onInput={set("line1")}
        />
        <Field
          label="Address line 2"
          value={values.line2}
          autocomplete="address-line2"
          maxLength={200}
          onInput={set("line2")}
        />
        {props.cities ? (
          <label class="field">
            <span>City</span>
            <select
              value={values.city}
              required
              onChange={(event) => set("city")((event.target as HTMLSelectElement).value)}
            >
              <option value="">Choose a city</option>
              {props.cities.map((city) => (
                <option key={city} value={city}>
                  {city}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <Field
            label="City"
            value={values.city}
            autocomplete="address-level2"
            required
            maxLength={80}
            onInput={set("city")}
          />
        )}
        <Field
          label="Email"
          type="email"
          value={values.email}
          autocomplete="email"
          maxLength={254}
          onInput={set("email")}
        />
        <Field
          label="Note for the courier"
          value={values.note}
          autocomplete="off"
          maxLength={500}
          onInput={set("note")}
        />
      </fieldset>
      <button type="submit" class="primary" disabled={props.busy || !complete}>
        Continue
      </button>
    </form>
  );
}

/** Cash on delivery, step 2: the order as the store quoted it. Confirm is the only way to place it. */
export function CodSummary(props: { part: SummaryPart; busy: boolean; onAction: RunAction }) {
  const [editing, setEditing] = useState(false);
  const { part } = props;
  if (editing) {
    return (
      <DeliveryForm
        countryCode={part.countryCode}
        cities={null}
        prefill={part.deliverTo}
        busy={props.busy}
        onAction={props.onAction}
      />
    );
  }
  const to = part.deliverTo;
  return (
    <div class="card cod-summary">
      <span class="title">Cash on delivery: please check your order</span>
      <ul>
        {part.lines.map((line) => (
          <li key={line.id} class="line">
            <span>
              {line.quantity} × {line.title} · {line.variantTitle}
            </span>
            <span class="price">{formatMoney(line.lineTotal)}</span>
          </li>
        ))}
      </ul>
      <div class="subtotal">
        <span>Subtotal</span>
        <span>{formatMoney(part.subtotal)}</span>
      </div>
      <div class="subtotal">
        <span>Delivery</span>
        <span>{formatMoney(part.deliveryFee)}</span>
      </div>
      <div class="subtotal total">
        <span>Pay on delivery</span>
        <span>{formatMoney(part.total)}</span>
      </div>
      <address>
        {to.name}, {to.phone}
        <br />
        {[to.line1, to.line2, to.city].filter(Boolean).join(", ")}
      </address>
      <button
        type="button"
        class="primary"
        disabled={props.busy}
        onClick={() => props.onAction("place_cod_order", {})}
      >
        Confirm order
      </button>
      <button type="button" disabled={props.busy} onClick={() => setEditing(true)}>
        Edit details
      </button>
    </div>
  );
}
