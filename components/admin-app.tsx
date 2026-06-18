"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  AUTH_EXPIRED_EVENT,
  apiRequest,
  apiRequestWithRefresh,
  clearSession,
  loadSession,
  makeDeviceId,
  refreshSession,
  staffLogin,
} from "@/lib/admin-api";
import { adminModules } from "@/lib/admin-modules";
import type { ApiOptions } from "@/lib/admin-api";
import type { AdminField, AdminModule, JsonRecord, StoredSession, UploadAction } from "@/lib/admin-types";

type FormState = Record<string, unknown>;
type SelectOption = { label: string; value: string };
type Requester = <T>(path: string, options?: ApiOptions) => Promise<T>;

const weekDays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function defaultWorkingHours() {
  return weekDays.map((_, weekday) => ({
    weekday,
    is_closed: false,
    opens_at: "10:00:00",
    closes_at: "22:00:00",
  }));
}

const slideCreateFields: AdminField[] = [
  { name: "title", label: "Title", type: "text", emptyAsNull: true },
  { name: "caption", label: "Caption", type: "textarea", emptyAsNull: true, wide: true },
  { name: "duration_seconds", label: "Duration seconds", type: "number", parser: "integer", emptyAsNull: true },
  { name: "sort_order", label: "Sort", type: "number", parser: "integer", defaultValue: 0 },
  { name: "is_active", label: "Active", type: "checkbox", defaultValue: true },
];

const slideUpdateFields: AdminField[] = [
  {
    name: "media_type",
    label: "Media type",
    type: "select",
    emptyAsNull: true,
    options: [
      { label: "image", value: "image" },
      { label: "video", value: "video" },
    ],
  },
  ...slideCreateFields,
];

const menuOverrideFields: AdminField[] = [
  { name: "iiko_item_id", label: "IIKO item ID", type: "text", emptyAsNull: true },
  { name: "sku", label: "SKU", type: "text", emptyAsNull: true },
  { name: "name_override", label: "Name override", type: "text", emptyAsNull: true },
  { name: "description", label: "Description", type: "textarea", emptyAsNull: true, wide: true },
  { name: "image_url", label: "Image URL", type: "text", emptyAsNull: true, wide: true },
  { name: "sort_order", label: "Sort", type: "number", parser: "integer", defaultValue: 0 },
  { name: "is_active", label: "Active", type: "checkbox", defaultValue: true },
];

const emptyModule = (fields: AdminField[]): AdminModule => ({
  key: "form",
  title: "Form",
  tableName: "form",
  description: "",
  listPath: "",
  createPath: "",
  updatePath: () => "",
  deletePath: () => "",
  idField: "id",
  columns: [],
  fields,
});

function stringify(value: unknown) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

function mediaHref(value: unknown) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (/^https?:\/\//i.test(text)) return text;
  if (text.startsWith("/api/proxy/")) return text;
  if (text.startsWith("/")) return `/api/proxy${text}`;
  return "";
}

function isImageHref(value: unknown) {
  const href = mediaHref(value);
  if (!href) return false;
  return /\.(avif|gif|jpe?g|png|webp)(\?.*)?$/i.test(href) || /\/media\//i.test(href);
}

function compactMedia(value: unknown) {
  const href = mediaHref(value);
  const text = String(value ?? "");
  if (!href) return compact(value);

  return (
    <a className="media-link" href={href} target="_blank" rel="noreferrer">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {isImageHref(value) ? <img className="thumb" src={href} alt="" loading="lazy" /> : null}
      <span>{text.length > 42 ? `${text.slice(0, 39)}...` : text}</span>
    </a>
  );
}

function normalizeTimeInput(value: unknown) {
  const text = String(value ?? "").trim();
  return text.length === 5 ? `${text}:00` : text;
}

function normalizeWorkingHours(value: unknown) {
  const rows = Array.isArray(value) ? (value as JsonRecord[]) : [];
  const byWeekday = new Map(rows.map((row) => [Number(row.weekday), row]));

  return weekDays.map((_, weekday) => {
    const source = byWeekday.get(weekday);
    const isClosed = Boolean(source?.is_closed);
    return {
      weekday,
      is_closed: isClosed,
      opens_at: isClosed ? "" : String(source?.opens_at || "10:00:00"),
      closes_at: isClosed ? "" : String(source?.closes_at || "22:00:00"),
    };
  });
}

function serializeWorkingHours(value: unknown) {
  return normalizeWorkingHours(value).map((row) => {
    if (row.is_closed) {
      return {
        weekday: row.weekday,
        is_closed: true,
        opens_at: null,
        closes_at: null,
      };
    }

    return {
      weekday: row.weekday,
      is_closed: false,
      opens_at: normalizeTimeInput(row.opens_at),
      closes_at: normalizeTimeInput(row.closes_at),
    };
  });
}

function compact(value: unknown) {
  if (value === null || value === undefined || value === "") return <span className="muted">NULL</span>;
  if (typeof value === "boolean") return value ? <span className="ok">true</span> : <span className="danger">false</span>;
  if (Array.isArray(value)) return <span>{value.length} items</span>;
  if (typeof value === "object") return <span>{JSON.stringify(value)}</span>;
  const text = String(value);
  if (mediaHref(text)) {
    return (
      <a href={mediaHref(text)} target="_blank" rel="noreferrer">
        {text.length > 42 ? `${text.slice(0, 39)}...` : text}
      </a>
    );
  }
  return text.length > 64 ? `${text.slice(0, 61)}...` : text;
}

function fieldValue(row: JsonRecord, field: AdminField) {
  const keys = [field.name, ...(field.aliases || [])];
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(row, key)) {
      return { found: true, value: row[key] };
    }
  }
  return { found: false, value: undefined };
}

function normalizeFieldValue(field: AdminField, value: unknown) {
  if (field.type === "json") return stringify(value);
  if (field.type === "working-hours") return normalizeWorkingHours(value);
  return value;
}

function initialForm(module: AdminModule, row?: JsonRecord | null): FormState {
  return module.fields.reduce<FormState>((acc, field) => {
    if (row) {
      const source = fieldValue(row, field);
      if (source.found) {
        acc[field.name] = normalizeFieldValue(field, source.value);
        return acc;
      }
      if (field.name === "is_active" && Object.prototype.hasOwnProperty.call(row, "active")) {
        acc[field.name] = row.active;
        return acc;
      }
      if (field.name === "preview_url" && Object.prototype.hasOwnProperty.call(row, "previewImage")) {
        acc[field.name] = row.previewImage;
        return acc;
      }
      if (field.name === "image_url" && Object.prototype.hasOwnProperty.call(row, "image")) {
        acc[field.name] = row.image;
        return acc;
      }
      acc[field.name] = undefined;
      return acc;
    }
    if (field.defaultValue !== undefined) {
      acc[field.name] =
        field.type === "json"
          ? stringify(field.defaultValue)
          : field.type === "working-hours"
            ? normalizeWorkingHours(field.defaultValue)
            : field.defaultValue;
      return acc;
    }
    acc[field.name] =
      field.type === "checkbox" ? false : field.type === "working-hours" ? defaultWorkingHours() : "";
    return acc;
  }, {});
}

function readPath(record: JsonRecord, path: string) {
  return path.split(".").reduce<unknown>((value, part) => {
    if (!value || typeof value !== "object") return undefined;
    return (value as JsonRecord)[part];
  }, record);
}

function optionLabel(row: JsonRecord, fields: string[]) {
  const parts = fields
    .map((field) => readPath(row, field))
    .filter((value) => value !== null && value !== undefined && value !== "")
    .map(String);

  if (parts.length) return parts.join(" / ");
  return String(row.name || row.title || row.slug || row.id || "record");
}

function displayValue(value: unknown) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return optionLabel(value as JsonRecord, ["title", "name", "slug"]);
  }
  if (typeof value === "string" && mediaHref(value)) return compactMedia(value);
  return compact(value);
}

function numberValue(value: unknown) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : 0;
}

function money(value: unknown) {
  return numberValue(value).toLocaleString("ru-RU", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 0,
  });
}

function isProblemOrder(order: JsonRecord) {
  const paymentStatus = String(order.paymentStatus || "").toLowerCase();
  const creationStatus = String(order.creationStatus || "").toLowerCase();
  const orderStatus = String(order.orderStatus || "").toLowerCase();

  return (
    paymentStatus.includes("failed") ||
    paymentStatus.includes("cancel") ||
    paymentStatus.includes("expired") ||
    creationStatus === "error" ||
    orderStatus === "cancelled" ||
    Boolean(order.errorInfo || order.paymentErrorInfo)
  );
}

function countBy(rows: JsonRecord[], field: string) {
  return rows.reduce<Record<string, number>>((acc, row) => {
    const key = String(row[field] ?? "NULL");
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function topEntries(record: Record<string, number>, limit = 8) {
  return Object.entries(record)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit);
}

function parsePayload(fields: AdminField[], state: FormState, partial: boolean) {
  const payload: JsonRecord = {};

  for (const field of fields) {
    const raw = state[field.name];
    if (partial && raw === undefined) continue;

    if (field.type === "checkbox") {
      payload[field.name] = Boolean(raw);
      continue;
    }

    if (field.type === "working-hours") {
      payload[field.name] = serializeWorkingHours(raw);
      continue;
    }

    if (raw === "" || raw === undefined) {
      if (field.emptyAsNull) payload[field.name] = null;
      else if (!partial) payload[field.name] = "";
      continue;
    }

    if (field.type === "json" || field.parser === "json") {
      payload[field.name] = typeof raw === "string" ? JSON.parse(raw) : raw;
      continue;
    }

    if (field.parser === "number") {
      payload[field.name] = Number(raw);
      continue;
    }

    if (field.parser === "integer") {
      payload[field.name] = Number.parseInt(String(raw), 10);
      continue;
    }

    payload[field.name] = raw;
  }

  return payload;
}

function toFiles(files: FileList | null) {
  return Array.from(files || []);
}

function appendExtraFields(form: FormData, fields: AdminField[] | undefined, state: FormState) {
  if (!fields?.length) return;

  const payload = parsePayload(fields, state, false);
  Object.entries(payload).forEach(([key, value]) => {
    if (value !== null && value !== undefined) form.append(key, String(value));
  });
}

async function uploadActionFiles(
  action: UploadAction,
  row: JsonRecord,
  files: File[],
  extraState: FormState,
  request: Requester,
) {
  const form = new FormData();
  files.forEach((file) => form.append(action.fieldName, file));
  appendExtraFields(form, action.extraFields, extraState);

  return request<JsonRecord>(action.path(row), {
    method: "POST",
    body: form,
  });
}

function LoginScreen({ onLogin }: { onLogin: (session: StoredSession) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [deviceId, setDeviceId] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDeviceId(makeDeviceId());
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setStatus("Проверяю логин...");
    try {
      const actualDeviceId = deviceId || makeDeviceId();
      setDeviceId(actualDeviceId);
      const session = await staffLogin({ email, password, deviceId: actualDeviceId });
      setStatus("Вход выполнен.");
      onLogin(session);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Не удалось войти.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-page">
      <form className="login-box" onSubmit={submit}>
        <div className="login-head">
          <h1>MangalClubs Admin</h1>
        </div>
        <div className="login-body">
          <div className="login-grid">
            <label>
              Email
              <input value={email} type="email" onChange={(event) => setEmail(event.target.value)} required />
            </label>
            <label>
              Password
              <input
                value={password}
                type="password"
                minLength={8}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </label>
          </div>
          <div className="panel-actions">
            <button disabled={busy} type="submit">
              Войти
            </button>
            <span className={status.includes("выполнен") ? "ok" : "muted"}>{status}</span>
          </div>
        </div>
      </form>
    </main>
  );
}

function FieldInput({
  field,
  value,
  onChange,
  options,
}: {
  field: AdminField;
  value: unknown;
  onChange: (value: unknown) => void;
  options?: SelectOption[];
}) {
  if (field.type === "working-hours") {
    const rows = normalizeWorkingHours(value);

    function updateRow(index: number, patch: Partial<(typeof rows)[number]>) {
      onChange(rows.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)));
    }

    return (
      <div className={`working-hours-editor ${field.wide ? "wide" : ""}`}>
        <span className="field-title">{field.label}</span>
        <div className="working-hours-grid">
          {rows.map((row, index) => (
            <div key={row.weekday} className="working-hours-row">
              <span>{weekDays[row.weekday]}</span>
              <label className="check-label compact-check">
                <input
                  checked={row.is_closed}
                  type="checkbox"
                  onChange={(event) => updateRow(index, { is_closed: event.target.checked })}
                />
                closed
              </label>
              <input
                disabled={row.is_closed}
                type="time"
                value={String(row.opens_at || "").slice(0, 5)}
                onChange={(event) => updateRow(index, { opens_at: event.target.value })}
              />
              <input
                disabled={row.is_closed}
                type="time"
                value={String(row.closes_at || "").slice(0, 5)}
                onChange={(event) => updateRow(index, { closes_at: event.target.value })}
              />
            </div>
          ))}
        </div>
        {field.help ? <span className="json-help">{field.help}</span> : null}
      </div>
    );
  }

  if (field.type === "checkbox") {
    return (
      <label className={`check-label ${field.wide ? "wide" : ""}`}>
        <input checked={Boolean(value)} type="checkbox" onChange={(event) => onChange(event.target.checked)} />
        {field.label}
      </label>
    );
  }

  if (field.type === "textarea" || field.type === "json") {
    return (
      <label className={field.wide ? "wide" : ""}>
        {field.label}
        <textarea
          value={String(value ?? "")}
          placeholder={field.placeholder}
          onChange={(event) => onChange(event.target.value)}
          required={field.required}
        />
        {field.help ? <span className="json-help">{field.help}</span> : null}
      </label>
    );
  }

  if (field.type === "select") {
    const choices = options?.length ? options : field.options || [];

    if (!choices.length) {
      return (
        <label className={field.wide ? "wide" : ""}>
          {field.label}
          <input
            value={String(value ?? "")}
            placeholder="UUID"
            type="text"
            onChange={(event) => onChange(event.target.value)}
            required={field.required}
          />
          <span className="json-help">Список не загружен, можно вписать ID вручную.</span>
        </label>
      );
    }

    return (
      <label className={field.wide ? "wide" : ""}>
        {field.label}
        <select value={String(value ?? "")} onChange={(event) => onChange(event.target.value)} required={field.required}>
          <option value="">{field.required ? "Выберите запись" : "Не выбрано"}</option>
          {choices.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    );
  }

  return (
    <label className={field.wide ? "wide" : ""}>
      {field.label}
      <input
        value={String(value ?? "")}
        name={field.inputName || field.name}
        autoComplete={field.autoComplete}
        data-lpignore={field.autoComplete === "off" ? "true" : undefined}
        data-form-type={field.autoComplete === "off" ? "other" : undefined}
        placeholder={field.placeholder}
        type={field.type === "time" ? "time" : field.type}
        onChange={(event) => onChange(event.target.value)}
        required={field.required}
      />
    </label>
  );
}

function UploadControl({
  action,
  row,
  request,
  onDone,
}: {
  action: UploadAction;
  row: JsonRecord;
  request: Requester;
  onDone: (record?: JsonRecord) => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [extraState, setExtraState] = useState<FormState>(() =>
    initialForm(emptyModule(action.extraFields || []), null),
  );
  const fileNames = files.map((file) => file.name).join(", ");

  async function upload() {
    if (!files.length) {
      setStatus("Выберите файл.");
      return;
    }
    setBusy(true);
    setStatus("Загрузка...");
    try {
      const result = await uploadActionFiles(action, row, files, extraState, request);
      setStatus("Готово");
      setFiles([]);
      await onDone(result);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Ошибка загрузки.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="upload-box">
      {action.extraFields?.length ? (
        <div className="upload-fields">
          {action.extraFields.map((field) => (
            <FieldInput
              key={field.name}
              field={field}
              value={extraState[field.name]}
              onChange={(value) => setExtraState((current) => ({ ...current, [field.name]: value }))}
            />
          ))}
        </div>
      ) : null}
      <label className="file-picker">
        <span>{action.label}</span>
        <input
          accept={action.accept}
          multiple={action.multiple}
          type="file"
          onChange={(event) => setFiles(toFiles(event.target.files))}
        />
      </label>
      {fileNames ? <span className="small muted">{fileNames}</span> : null}
      <button disabled={busy || !files.length} type="button" onClick={upload}>
        {busy ? "..." : "Загрузить"}
      </button>
      {status ? <span className="small muted">{status}</span> : null}
    </div>
  );
}

function slideFormFromRow(slide?: JsonRecord | null) {
  if (!slide) return initialForm(emptyModule(slideUpdateFields), null);
  const row: JsonRecord = {
    ...slide,
    url: slide.src,
    media_type: slide.type,
    is_active: slide.active,
  };
  return initialForm(emptyModule(slideUpdateFields), row);
}

async function finishStoryEdit(
  nextStory: JsonRecord,
  message: string,
  onStoryChange: (story: JsonRecord) => void,
  onDone: () => void | Promise<void>,
  setStatus: (status: string) => void,
) {
  onStoryChange(nextStory);
  setStatus(message);
  await onDone();
}

function StorySlideEditForm({
  story,
  slide,
  request,
  onStoryChange,
  onDone,
}: {
  story: JsonRecord;
  slide: JsonRecord;
  request: Requester;
  onStoryChange: (story: JsonRecord) => void;
  onDone: () => void | Promise<void>;
}) {
  const [editState, setEditState] = useState<FormState>(() => slideFormFromRow(slide));
  const [mediaFile, setMediaFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  async function updateSlide(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setStatus("Сохраняю slide...");
    try {
      const payload = parsePayload(slideUpdateFields, editState, true);
      const nextStory = await request<JsonRecord>(`/api/v1/stories/${story.id}/slides/${slide.id}`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      await finishStoryEdit(nextStory, "Slide обновлён.", onStoryChange, onDone, setStatus);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Не удалось сохранить slide.");
    } finally {
      setBusy(false);
    }
  }

  async function uploadMedia() {
    if (!mediaFile) {
      setStatus("Выберите файл media.");
      return;
    }
    setBusy(true);
    setStatus("Заменяю media...");
    try {
      const form = new FormData();
      form.append("media", mediaFile);
      const nextStory = await request<JsonRecord>(`/api/v1/stories/${story.id}/slides/${slide.id}/media`, {
        method: "POST",
        body: form,
      });
      setMediaFile(null);
      await finishStoryEdit(nextStory, "Media обновлена.", onStoryChange, onDone, setStatus);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Не удалось загрузить media.");
    } finally {
      setBusy(false);
    }
  }

  async function deleteSlide() {
    const name = String(slide.title || slide.src || slide.id);
    if (!window.confirm(`Удалить slide ${name}?`)) return;
    setBusy(true);
    setStatus("Удаляю slide...");
    try {
      const nextStory = await request<JsonRecord>(`/api/v1/stories/${story.id}/slides/${slide.id}`, {
        method: "DELETE",
      });
      await finishStoryEdit(nextStory, "Slide удалён.", onStoryChange, onDone, setStatus);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Не удалось удалить slide.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="nested-form" onSubmit={updateSlide}>
      <p className="small muted">Редактировать выбранный slide</p>
      <div className="form-grid">
        {slideUpdateFields.map((field) => (
          <FieldInput
            key={field.name}
            field={field}
            value={editState[field.name]}
            onChange={(value) => setEditState((current) => ({ ...current, [field.name]: value }))}
          />
        ))}
        <label className="wide">
          Replace media
          <input accept="image/*,video/*" type="file" onChange={(event) => setMediaFile(event.target.files?.[0] || null)} />
        </label>
      </div>
      <div className="panel-actions">
        <button disabled={busy} type="submit">
          Сохранить slide
        </button>
        <button disabled={busy || !mediaFile} type="button" onClick={uploadMedia}>
          Заменить media
        </button>
        <button className="danger" disabled={busy} type="button" onClick={deleteSlide}>
          Удалить slide
        </button>
      </div>
      <p className="status-line muted">{status}</p>
    </form>
  );
}

function StorySlidesEditor({
  story,
  request,
  onStoryChange,
  onDone,
}: {
  story: JsonRecord;
  request: Requester;
  onStoryChange: (story: JsonRecord) => void;
  onDone: () => void | Promise<void>;
}) {
  const slides = useMemo(() => (Array.isArray(story.slides) ? (story.slides as JsonRecord[]) : []), [story.slides]);
  const [selectedSlideId, setSelectedSlideId] = useState(() => String(slides[0]?.id || ""));
  const selectedSlide =
    selectedSlideId === "" ? null : slides.find((slide) => String(slide.id) === selectedSlideId) || slides[0] || null;
  const selectValue = selectedSlide ? String(selectedSlide.id) : "";
  const [createState, setCreateState] = useState<FormState>(() => initialForm(emptyModule(slideCreateFields)));
  const [createFile, setCreateFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  async function createSlide(event: FormEvent) {
    event.preventDefault();
    if (!createFile) {
      setStatus("Выберите файл слайда.");
      return;
    }
    setBusy(true);
    setStatus("Создаю slide...");
    try {
      const form = new FormData();
      form.append("media", createFile);
      const payload = parsePayload(slideCreateFields, createState, false);
      Object.entries(payload).forEach(([key, value]) => {
        if (value !== null && value !== undefined) form.append(key, String(value));
      });
      const nextStory = await request<JsonRecord>(`/api/v1/stories/${story.id}/slides`, {
        method: "POST",
        body: form,
      });
      setCreateFile(null);
      setCreateState(initialForm(emptyModule(slideCreateFields)));
      await finishStoryEdit(nextStory, "Slide создан.", onStoryChange, onDone, setStatus);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Не удалось создать slide.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="story-slides">
      <div className="story-slide-list">
        <label>
          Slides ({slides.length})
          <select value={selectValue} onChange={(event) => setSelectedSlideId(event.target.value)}>
            <option value="">Новый slide</option>
            {slides.map((slide, index) => (
              <option key={String(slide.id)} value={String(slide.id)}>
                {optionLabel(slide, ["title", "src", "id"]) || `Slide ${index + 1}`}
              </option>
            ))}
          </select>
        </label>
      </div>

      <form className="nested-form" onSubmit={createSlide}>
        <p className="small muted">Создать slide</p>
        <div className="form-grid">
          {slideCreateFields.map((field) => (
            <FieldInput
              key={field.name}
              field={field}
              value={createState[field.name]}
              onChange={(value) => setCreateState((current) => ({ ...current, [field.name]: value }))}
            />
          ))}
          <label className="wide">
            Media
            <input accept="image/*,video/*" type="file" onChange={(event) => setCreateFile(event.target.files?.[0] || null)} />
          </label>
        </div>
        <div className="panel-actions">
          <button disabled={busy} type="submit">
            Создать slide
          </button>
        </div>
      </form>

      {selectedSlide ? (
        <StorySlideEditForm
          key={String(selectedSlide.id)}
          story={story}
          slide={selectedSlide}
          request={request}
          onStoryChange={onStoryChange}
          onDone={onDone}
        />
      ) : null}

      <p className="status-line muted">{status}</p>
    </div>
  );
}

type MenuBrowserItem = JsonRecord & {
  rowKey: string;
  categoryTitle: string;
};

function menuItemIdentity(item: JsonRecord | null | undefined) {
  if (!item) return "";
  return String(item.iiko_item_id || item.id || item.sku || "");
}

function findMenuOverride(item: JsonRecord | null, overrides: JsonRecord[]) {
  if (!item) return null;
  const itemId = String(item.id || "");
  const sku = String(item.sku || "");

  return (
    overrides.find((override) => {
      const overrideIikoId = String(override.iiko_item_id || "");
      const overrideSku = String(override.sku || "");
      return (itemId && overrideIikoId === itemId) || (sku && overrideSku === sku);
    }) || null
  );
}

function menuOverrideInitial(item: JsonRecord | null, override: JsonRecord | null) {
  if (override) return initialForm(emptyModule(menuOverrideFields), override);

  return initialForm(emptyModule(menuOverrideFields), {
    iiko_item_id: item?.id || "",
    sku: item?.sku || "",
    name_override: item?.name || "",
    description: item?.description || "",
    image_url: item?.image || "",
    sort_order: 0,
    is_active: true,
  });
}

function flattenMenu(menu: JsonRecord | null) {
  const sections = Array.isArray(menu?.menu) ? (menu.menu as JsonRecord[]) : [];

  return sections.flatMap<MenuBrowserItem>((section, sectionIndex) => {
    const items = Array.isArray(section.items) ? (section.items as JsonRecord[]) : [];
    return items.map((item, itemIndex) => ({
      ...item,
      categoryTitle: String(section.title || section.id || "category"),
      rowKey: `${section.id || sectionIndex}:${item.id || item.sku || itemIndex}`,
    }));
  });
}

function MenuBrowser({
  request,
  onDone,
}: {
  request: Requester;
  onDone: () => void | Promise<void>;
}) {
  const [organizations, setOrganizations] = useState<JsonRecord[]>([]);
  const [organizationId, setOrganizationId] = useState("");
  const [orderType, setOrderType] = useState("pickup");
  const [menu, setMenu] = useState<JsonRecord | null>(null);
  const [overrides, setOverrides] = useState<JsonRecord[]>([]);
  const [selectedKey, setSelectedKey] = useState("");
  const [editState, setEditState] = useState<FormState>(() => menuOverrideInitial(null, null));
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  const menuItems = useMemo(() => flattenMenu(menu), [menu]);
  const filteredItems = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return menuItems;
    return menuItems.filter((item) => JSON.stringify(item).toLowerCase().includes(q));
  }, [filter, menuItems]);

  const selectedItem = useMemo(
    () => menuItems.find((item) => item.rowKey === selectedKey) || null,
    [menuItems, selectedKey],
  );
  const selectedOverride = useMemo(
    () => findMenuOverride(selectedItem, overrides),
    [overrides, selectedItem],
  );

  const overrideCount = overrides.length;
  const selectedHasOverride = Boolean(selectedOverride);

  async function loadOrganizations() {
    const data = await request<JsonRecord[]>("/api/v1/organizations");
    const list = Array.isArray(data) ? data : [];
    setOrganizations(list);
    setOrganizationId((current) => current || String(list[0]?.id || ""));
  }

  async function loadOverrides() {
    const data = await request<JsonRecord[]>("/api/v1/menu/admin/items");
    setOverrides(Array.isArray(data) ? data : []);
  }

  async function loadMenu(refresh = false) {
    if (!organizationId) {
      setStatus("Choose organization first.");
      return;
    }

    setBusy(true);
    setStatus(refresh ? "Refreshing menu..." : "Loading menu...");
    try {
      const query = new URLSearchParams({
        orderType,
        refresh: String(refresh),
      });
      const data = await request<JsonRecord>(`/api/v1/menu/admin/organizations/${organizationId}?${query}`);
      setMenu(data && typeof data === "object" ? data : null);
      setSelectedKey("");
      await loadOverrides();
      setStatus(`Menu loaded: ${flattenMenu(data && typeof data === "object" ? data : null).length} items.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Menu load failed.");
    } finally {
      setBusy(false);
    }
  }

  async function syncMenu() {
    if (!organizationId) {
      setStatus("Choose organization first.");
      return;
    }

    setBusy(true);
    setStatus("Syncing menu...");
    try {
      const query = new URLSearchParams({ orderType });
      const data = await request<JsonRecord>(`/api/v1/menu/admin/organizations/${organizationId}/sync?${query}`, {
        method: "POST",
      });
      setMenu(data && typeof data === "object" ? data : null);
      setSelectedKey("");
      await loadOverrides();
      setStatus("Menu synced.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Menu sync failed.");
    } finally {
      setBusy(false);
    }
  }

  async function saveOverride(event: FormEvent) {
    event.preventDefault();
    const payload = parsePayload(menuOverrideFields, editState, Boolean(selectedOverride));
    const hasIdentity = Boolean(payload.iiko_item_id || payload.sku);

    if (!hasIdentity) {
      setStatus("Set IIKO item ID or SKU.");
      return;
    }

    setBusy(true);
    setStatus(selectedOverride ? "Updating override..." : "Creating override...");
    try {
      let result = await request<JsonRecord>(
        selectedOverride ? `/api/v1/menu/admin/items/${selectedOverride.id}` : "/api/v1/menu/admin/items",
        {
          method: selectedOverride ? "PATCH" : "POST",
          body: JSON.stringify(payload),
        },
      );

      if (imageFile) {
        const form = new FormData();
        form.append("image", imageFile);
        result = await request<JsonRecord>(`/api/v1/menu/admin/items/${result.id}/image`, {
          method: "POST",
          body: form,
        });
        setImageFile(null);
      }

      await loadOverrides();
      await onDone();
      setEditState(initialForm(emptyModule(menuOverrideFields), result));
      setStatus("Override saved.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Override save failed.");
    } finally {
      setBusy(false);
    }
  }

  function selectMenuItem(item: MenuBrowserItem) {
    const override = findMenuOverride(item, overrides);
    setSelectedKey(item.rowKey);
    setEditState(menuOverrideInitial(item, override));
    setImageFile(null);
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      Promise.all([loadOrganizations(), loadOverrides()]).catch((error) => {
        setStatus(error instanceof Error ? error.message : "Menu editor init failed.");
      });
    }, 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selectedItem) return;
    const timer = window.setTimeout(() => {
      setEditState(menuOverrideInitial(selectedItem, selectedOverride));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [selectedItem, selectedOverride]);

  return (
    <fieldset className="menu-browser">
      <legend>Menu editor</legend>
      <div className="menu-browser-head">
        <label>
          Organization
          <select value={organizationId} onChange={(event) => setOrganizationId(event.target.value)}>
            <option value="">Choose organization</option>
            {organizations.map((organization) => (
              <option key={String(organization.id)} value={String(organization.id)}>
                {optionLabel(organization, ["name", "slug", "id"])}
              </option>
            ))}
          </select>
        </label>
        <label>
          Order type
          <select value={orderType} onChange={(event) => setOrderType(event.target.value)}>
            <option value="pickup">pickup</option>
            <option value="delivery">delivery</option>
          </select>
        </label>
        <button disabled={busy || !organizationId} type="button" onClick={() => void loadMenu(false)}>
          Load menu
        </button>
        <button disabled={busy || !organizationId} type="button" onClick={() => void loadMenu(true)}>
          Refresh cache
        </button>
        <button disabled={busy || !organizationId} type="button" onClick={() => void syncMenu()}>
          Sync from IIKO
        </button>
        <span className="small muted">Overrides: {overrideCount}</span>
      </div>

      <div className="menu-browser-grid">
        <div>
          <div className="toolbar compact-toolbar">
            <label>
              Search menu ({menuItems.length})
              <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="name, sku, category" />
            </label>
          </div>
          <div className="table-wrap menu-table">
            <table>
              <thead>
                <tr>
                  <th>Action</th>
                  <th>Category</th>
                  <th>Name</th>
                  <th>SKU</th>
                  <th>Price</th>
                  <th>Override</th>
                </tr>
              </thead>
              <tbody>
                {filteredItems.map((item) => {
                  const override = findMenuOverride(item, overrides);
                  return (
                    <tr key={item.rowKey} className={item.rowKey === selectedKey ? "selected-row" : ""}>
                      <td>
                        <button className="link-button" type="button" onClick={() => selectMenuItem(item)}>
                          edit
                        </button>
                      </td>
                      <td>{compact(item.categoryTitle)}</td>
                      <td>{compact(item.name)}</td>
                      <td>{compact(item.sku)}</td>
                      <td>{compact(item.price)}</td>
                      <td>{override ? <span className="ok">yes</span> : <span className="muted">no</span>}</td>
                    </tr>
                  );
                })}
                {!filteredItems.length ? (
                  <tr>
                    <td colSpan={6} className="muted">
                      Load menu or change search.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>

        <form className="nested-form" onSubmit={saveOverride}>
          <p className="small muted">
            {selectedItem
              ? `${selectedHasOverride ? "Edit" : "Create"} override for ${selectedItem.name || menuItemIdentity(selectedItem)}`
              : "Select menu item or fill identity manually."}
          </p>
          <div className="form-grid">
            {menuOverrideFields.map((field) => (
              <FieldInput
                key={field.name}
                field={field}
                value={editState[field.name]}
                onChange={(value) => setEditState((current) => ({ ...current, [field.name]: value }))}
              />
            ))}
            <label className="wide">
              Image file
              <input accept="image/*" type="file" onChange={(event) => setImageFile(event.target.files?.[0] || null)} />
            </label>
          </div>
          <div className="panel-actions">
            <button disabled={busy} type="submit">
              {selectedHasOverride ? "Save override" : "Create override"}
            </button>
            <button
              disabled={busy}
              type="button"
              onClick={() => {
                setSelectedKey("");
                setEditState(menuOverrideInitial(null, null));
                setImageFile(null);
              }}
            >
              Clear
            </button>
          </div>
          <p className="status-line muted">{status}</p>
        </form>
      </div>
    </fieldset>
  );
}

function OrganizationTools({ organization, request }: { organization: JsonRecord; request: Requester }) {
  const [date, setDate] = useState("");
  const [stepMinutes, setStepMinutes] = useState("30");
  const [availability, setAvailability] = useState<JsonRecord | null>(null);
  const [slots, setSlots] = useState<JsonRecord | null>(null);
  const [paymentTypes, setPaymentTypes] = useState<unknown>(null);
  const [busy, setBusy] = useState("");
  const [status, setStatus] = useState("");
  const slug = String(organization.slug || "");
  const organizationId = String(organization.id || "");

  async function loadAvailability() {
    if (!slug) return;
    setBusy("availability");
    setStatus("Loading availability...");
    try {
      setAvailability(await request<JsonRecord>(`/api/v1/organizations/${slug}/availability`));
      setStatus("Availability loaded.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Availability load failed.");
    } finally {
      setBusy("");
    }
  }

  async function loadSlots() {
    if (!slug) return;
    setBusy("slots");
    setStatus("Loading slots...");
    try {
      const query = new URLSearchParams({ stepMinutes: stepMinutes || "30" });
      if (date) query.set("date", date);
      setSlots(await request<JsonRecord>(`/api/v1/organizations/${slug}/order-time-slots?${query}`));
      setStatus("Slots loaded.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Slots load failed.");
    } finally {
      setBusy("");
    }
  }

  async function loadPaymentTypes() {
    if (!organizationId) return;
    setBusy("payment-types");
    setStatus("Loading IIKO payment types...");
    try {
      setPaymentTypes(await request<unknown>(`/api/v1/organizations/admin/${organizationId}/iiko-payment-types`));
      setStatus("Payment types loaded.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Payment types load failed.");
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="story-slides">
      <p className="small muted">Organization tools</p>
      <div className="tool-grid">
        <fieldset>
          <legend>Availability</legend>
          <button disabled={busy === "availability" || !slug} type="button" onClick={() => void loadAvailability()}>
            Check availability
          </button>
          {availability ? <pre className="record-json">{JSON.stringify(availability, null, 2)}</pre> : null}
        </fieldset>
        <fieldset>
          <legend>Order slots</legend>
          <div className="form-grid">
            <label>
              Date
              <input value={date} type="date" onChange={(event) => setDate(event.target.value)} />
            </label>
            <label>
              Step minutes
              <input value={stepMinutes} type="number" min={5} max={240} onChange={(event) => setStepMinutes(event.target.value)} />
            </label>
          </div>
          <div className="panel-actions">
            <button disabled={busy === "slots" || !slug} type="button" onClick={() => void loadSlots()}>
              Load slots
            </button>
          </div>
          {slots ? <pre className="record-json">{JSON.stringify(slots, null, 2)}</pre> : null}
        </fieldset>
        <fieldset>
          <legend>IIKO payment types</legend>
          <button disabled={busy === "payment-types" || !organizationId} type="button" onClick={() => void loadPaymentTypes()}>
            Load payment types
          </button>
          {paymentTypes ? <pre className="record-json">{JSON.stringify(paymentTypes, null, 2)}</pre> : null}
        </fieldset>
      </div>
      <p className="status-line muted">{status}</p>
    </div>
  );
}

function OrderTools({ order, request, onOrderChange }: { order: JsonRecord; request: Requester; onOrderChange: (order: JsonRecord) => void }) {
  const [paymentEvents, setPaymentEvents] = useState<JsonRecord[]>([]);
  const [remoteStatus, setRemoteStatus] = useState<JsonRecord | null>(null);
  const [busy, setBusy] = useState("");
  const [status, setStatus] = useState("");
  const orderId = String(order.id || "");
  const publicNumber = String(order.publicNumber || "");

  async function loadFullOrder() {
    if (!orderId) return;
    const fresh = await request<JsonRecord>(`/api/v1/orders/admin/${orderId}`);
    onOrderChange(fresh);
  }

  async function loadPaymentEvents() {
    if (!orderId) return;
    setBusy("payment-events");
    setStatus("Loading payment events...");
    try {
      const eventPath = publicNumber
        ? `/api/v1/orders/admin/by-number/${encodeURIComponent(publicNumber)}/payment-events`
        : `/api/v1/orders/admin/${orderId}/payment-events`;
      const events = await request<JsonRecord[]>(eventPath);
      setPaymentEvents(Array.isArray(events) ? events : []);
      setStatus(`Payment events loaded: ${Array.isArray(events) ? events.length : 0}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Payment events load failed.");
    } finally {
      setBusy("");
    }
  }

  async function loadStatus() {
    if (!orderId) return;
    setBusy("status");
    setStatus("Loading IIKO status...");
    try {
      setRemoteStatus(await request<JsonRecord>(`/api/v1/orders/${orderId}/status`));
      await loadFullOrder();
      setStatus("Status loaded.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Status load failed.");
    } finally {
      setBusy("");
    }
  }

  async function dispatchIiko() {
    if (!orderId) return;
    if (!window.confirm(`Dispatch paid order ${orderId} to IIKO?`)) return;
    setBusy("dispatch");
    setStatus("Dispatching order...");
    try {
      const result = await request<JsonRecord>(`/api/v1/orders/admin/${orderId}/dispatch-iiko`, {
        method: "POST",
      });
      await loadFullOrder();
      setStatus(`Dispatch result: ${JSON.stringify(result)}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Dispatch failed.");
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="story-slides">
      <p className="small muted">Order tools</p>
      <div className="panel-actions">
        <button disabled={busy === "payment-events" || !orderId} type="button" onClick={() => void loadPaymentEvents()}>
          Payment events
        </button>
        <button disabled={busy === "status" || !orderId} type="button" onClick={() => void loadStatus()}>
          Get IIKO status
        </button>
        <button disabled={busy === "dispatch" || !orderId} type="button" onClick={() => void dispatchIiko()}>
          Dispatch to IIKO
        </button>
      </div>
      {paymentEvents.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>createdAt</th>
                <th>eventType</th>
                <th>status</th>
                <th>success</th>
                <th>processed</th>
              </tr>
            </thead>
            <tbody>
              {paymentEvents.map((event) => (
                <tr key={String(event.id)}>
                  <td>{compact(event.createdAt)}</td>
                  <td>{compact(event.eventType)}</td>
                  <td>{compact(event.status)}</td>
                  <td>{compact(event.success)}</td>
                  <td>{compact(event.processed)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {remoteStatus ? (
        <>
          <p className="small muted">IIKO status</p>
          <pre className="record-json">{JSON.stringify(remoteStatus, null, 2)}</pre>
        </>
      ) : null}
      <p className="status-line muted">{status}</p>
    </div>
  );
}

function BookingImagesEditor({
  booking,
  request,
  onBookingChange,
  onDone,
}: {
  booking: JsonRecord;
  request: Requester;
  onBookingChange: (booking: JsonRecord) => void;
  onDone: () => void | Promise<void>;
}) {
  const horizontalImages = Array.isArray(booking.horizontal_images) ? (booking.horizontal_images as JsonRecord[]) : [];
  const verticalImages = Array.isArray(booking.vertical_images) ? (booking.vertical_images as JsonRecord[]) : [];
  const images: JsonRecord[] = [
    ...horizontalImages.map((image) => ({ ...image, orientation: image.orientation || "horizontal" })),
    ...verticalImages.map((image) => ({ ...image, orientation: image.orientation || "vertical" })),
  ];
  const [busyId, setBusyId] = useState("");
  const [status, setStatus] = useState("");

  async function deleteImage(image: JsonRecord) {
    const imageId = String(image.id || "");
    if (!imageId) {
      setStatus("Image id is missing.");
      return;
    }

    if (!window.confirm(`Delete image ${imageId}?`)) return;

    setBusyId(imageId);
    setStatus("Deleting image...");
    try {
      const nextBooking = await request<JsonRecord>(`/api/v1/bookings/${booking.id}/images/${imageId}`, {
        method: "DELETE",
      });
      onBookingChange(nextBooking);
      await onDone();
      setStatus("Image deleted.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Image delete failed.");
    } finally {
      setBusyId("");
    }
  }

  return (
    <div className="story-slides">
      <p className="small muted">Booking images ({images.length})</p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Action</th>
              <th>URL</th>
              <th>Orientation</th>
              <th>Sort</th>
            </tr>
          </thead>
          <tbody>
            {images.map((image) => {
              const imageId = String(image.id || image.url || "");
              return (
                <tr key={imageId}>
                  <td>
                    <button
                      className="link-button danger"
                      disabled={busyId === String(image.id || "")}
                      type="button"
                      onClick={() => void deleteImage(image)}
                    >
                      delete
                    </button>
                  </td>
                  <td>{compactMedia(image.url)}</td>
                  <td>{compact(image.orientation)}</td>
                  <td>{compact(image.sort_order)}</td>
                </tr>
              );
            })}
            {!images.length ? (
              <tr>
                <td colSpan={4} className="muted">
                  No images.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <p className="status-line muted">{status}</p>
    </div>
  );
}

function OrderAnalytics({
  rows,
  request,
  onSelect,
  onRowsChange,
  onStatus,
}: {
  rows: JsonRecord[];
  request: Requester;
  onSelect: (row: JsonRecord) => void;
  onRowsChange: (rows: JsonRecord[]) => void;
  onStatus: (status: string) => void;
}) {
  const [publicNumber, setPublicNumber] = useState("");
  const [limit, setLimit] = useState("100");
  const [offset, setOffset] = useState("0");
  const [busy, setBusy] = useState("");
  const [localFilter, setLocalFilter] = useState("");
  const [status, setStatus] = useState("");

  const problemOrders = useMemo(() => rows.filter(isProblemOrder), [rows]);
  const paidOrders = useMemo(() => rows.filter((row) => row.paymentStatus === "paid"), [rows]);
  const totalRevenue = useMemo(
    () => paidOrders.reduce((sum, row) => sum + numberValue(row.paymentAmountKopecks) / 100, 0),
    [paidOrders],
  );
  const filteredProblems = useMemo(() => {
    const q = localFilter.trim().toLowerCase();
    if (!q) return problemOrders.slice(0, 12);
    return problemOrders.filter((row) => JSON.stringify(row).toLowerCase().includes(q)).slice(0, 12);
  }, [localFilter, problemOrders]);

  const paymentStats = topEntries(countBy(rows, "paymentStatus"));
  const creationStats = topEntries(countBy(rows, "creationStatus"));
  const organizationStats = topEntries(countBy(rows, "organizationSlug"), 6);

  async function searchByNumber(event: FormEvent) {
    event.preventDefault();
    const query = publicNumber.trim();
    if (!query) {
      setStatus("Введите номер заказа.");
      return;
    }

    setBusy("number");
    setStatus("Ищу заказ...");
    try {
      const order = await request<JsonRecord>(`/api/v1/orders/admin/by-number/${encodeURIComponent(query)}`);
      onSelect(order);
      setStatus(`Найден заказ ${order.publicNumber || order.id}.`);
      onStatus("Заказ найден по публичному номеру.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Заказ не найден.");
    } finally {
      setBusy("");
    }
  }

  async function loadWindow() {
    const nextLimit = Math.max(1, Math.min(200, Number.parseInt(limit || "100", 10) || 100));
    const nextOffset = Math.max(0, Number.parseInt(offset || "0", 10) || 0);
    setBusy("window");
    setStatus("Загружаю выборку заказов...");
    try {
      const query = new URLSearchParams({ limit: String(nextLimit), offset: String(nextOffset) });
      const data = await request<JsonRecord[]>(`/api/v1/orders/admin?${query}`);
      onRowsChange(Array.isArray(data) ? data : []);
      setLimit(String(nextLimit));
      setOffset(String(nextOffset));
      setStatus(`Загружено заказов: ${Array.isArray(data) ? data.length : 0}.`);
      onStatus(`Загружено заказов: ${Array.isArray(data) ? data.length : 0}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Не удалось загрузить заказы.");
    } finally {
      setBusy("");
    }
  }

  return (
    <fieldset className="analytics-panel">
      <legend>Аналитика заказов</legend>
      <div className="metric-grid">
        <div className="metric">
          <span>Заказов в выборке</span>
          <strong>{rows.length}</strong>
        </div>
        <div className="metric">
          <span>Оплачено</span>
          <strong>{paidOrders.length}</strong>
        </div>
        <div className="metric">
          <span>Проблемные</span>
          <strong className={problemOrders.length ? "danger" : "ok"}>{problemOrders.length}</strong>
        </div>
        <div className="metric">
          <span>Сумма paid</span>
          <strong>{money(totalRevenue)} ₽</strong>
        </div>
      </div>

      <div className="analytics-grid">
        <form className="nested-form" onSubmit={searchByNumber}>
          <p className="small muted">Быстрый поиск</p>
          <div className="form-grid">
            <label className="wide">
              Public number
              <input
                value={publicNumber}
                onChange={(event) => setPublicNumber(event.target.value)}
                placeholder="Например 000123"
              />
            </label>
          </div>
          <div className="panel-actions">
            <button disabled={busy === "number"} type="submit">
              Найти заказ
            </button>
          </div>
        </form>

        <div className="nested-form">
          <p className="small muted">Окно данных</p>
          <div className="form-grid">
            <label>
              Limit
              <input value={limit} type="number" min={1} max={200} onChange={(event) => setLimit(event.target.value)} />
            </label>
            <label>
              Offset
              <input value={offset} type="number" min={0} onChange={(event) => setOffset(event.target.value)} />
            </label>
          </div>
          <div className="panel-actions">
            <button disabled={busy === "window"} type="button" onClick={() => void loadWindow()}>
              Загрузить
            </button>
          </div>
        </div>
      </div>

      <div className="analytics-grid">
        <div className="stat-list">
          <p className="small muted">Payment status</p>
          {paymentStats.map(([name, count]) => (
            <button key={name} className="stat-row" type="button" onClick={() => setLocalFilter(name === "NULL" ? "" : name)}>
              <span>{name}</span>
              <strong>{count}</strong>
            </button>
          ))}
        </div>
        <div className="stat-list">
          <p className="small muted">Creation status</p>
          {creationStats.map(([name, count]) => (
            <button key={name} className="stat-row" type="button" onClick={() => setLocalFilter(name === "NULL" ? "" : name)}>
              <span>{name}</span>
              <strong>{count}</strong>
            </button>
          ))}
        </div>
        <div className="stat-list">
          <p className="small muted">Филиалы</p>
          {organizationStats.map(([name, count]) => (
            <button key={name} className="stat-row" type="button" onClick={() => setLocalFilter(name === "NULL" ? "" : name)}>
              <span>{name}</span>
              <strong>{count}</strong>
            </button>
          ))}
        </div>
      </div>

      <div className="toolbar compact-toolbar">
        <label>
          Фильтр проблемных заказов
          <input value={localFilter} onChange={(event) => setLocalFilter(event.target.value)} placeholder="status, phone, branch" />
        </label>
        <button type="button" onClick={() => setLocalFilter("")}>
          Сбросить
        </button>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Действие</th>
              <th>publicNumber</th>
              <th>createdAt</th>
              <th>organization</th>
              <th>phone</th>
              <th>payment</th>
              <th>creation</th>
              <th>order</th>
            </tr>
          </thead>
          <tbody>
            {filteredProblems.map((order) => (
              <tr key={String(order.id)}>
                <td>
                  <button className="link-button" type="button" onClick={() => onSelect(order)}>
                    открыть
                  </button>
                </td>
                <td>{compact(order.publicNumber)}</td>
                <td>{compact(order.createdAt)}</td>
                <td>{compact(order.organizationSlug)}</td>
                <td>{compact(order.phone)}</td>
                <td>{compact(order.paymentStatus)}</td>
                <td>{compact(order.creationStatus)}</td>
                <td>{compact(order.orderStatus)}</td>
              </tr>
            ))}
            {!filteredProblems.length ? (
              <tr>
                <td colSpan={8} className="muted">
                  В текущей выборке проблемных заказов нет.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <p className="status-line muted">{status}</p>
    </fieldset>
  );
}

function ModuleView({ module, request }: { module: AdminModule; request: Requester }) {
  const [rows, setRows] = useState<JsonRecord[]>([]);
  const [relationOptions, setRelationOptions] = useState<Record<string, SelectOption[]>>({});
  const [selected, setSelected] = useState<JsonRecord | null>(null);
  const [form, setForm] = useState<FormState>(() => initialForm(module));
  const [dirtyFields, setDirtyFields] = useState<Set<string>>(() => new Set());
  const [formFiles, setFormFiles] = useState<Record<string, File[]>>({});
  const [formUploadExtras, setFormUploadExtras] = useState<Record<string, FormState>>(() =>
    Object.fromEntries(
      (module.uploads || []).map((action) => [
        action.key,
        initialForm(emptyModule(action.extraFields || []), null),
      ]),
    ),
  );
  const [filter, setFilter] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  const filteredRows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((row) => JSON.stringify(row).toLowerCase().includes(q));
  }, [rows, filter]);

  async function loadRows() {
    setBusy(true);
    setStatus("Загрузка...");
    try {
      const data = await request<JsonRecord[]>(module.listPath);
      setRows(Array.isArray(data) ? data : []);
      setStatus(`Загружено: ${Array.isArray(data) ? data.length : 0}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Ошибка загрузки.");
    } finally {
      setBusy(false);
    }
  }

  async function loadRelations() {
    const fields = module.fields.filter((field) => field.relation);
    if (!fields.length) {
      setRelationOptions({});
      return;
    }

    const nextOptions: Record<string, SelectOption[]> = {};

    await Promise.all(
      fields.map(async (field) => {
        const relation = field.relation;
        const relatedModule = relation ? adminModules.find((item) => item.key === relation.moduleKey) : undefined;
        if (!relation || !relatedModule) return;

        try {
          const data = await request<JsonRecord[]>(relatedModule.listPath);
          const valueField = relation.valueField || relatedModule.idField;
          const labelFields = relation.labelFields || ["name", "title", "slug"];

          nextOptions[field.name] = (Array.isArray(data) ? data : []).map((row) => ({
            value: String(row[valueField] ?? ""),
            label: optionLabel(row, labelFields),
          }));
        } catch {
          nextOptions[field.name] = [];
        }
      }),
    );

    setRelationOptions(nextOptions);
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadRows();
      void loadRelations().catch((error) => {
        setStatus(error instanceof Error ? `Связанные списки: ${error.message}` : "Связанные списки не загружены.");
      });
    }, 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function selectRow(row: JsonRecord) {
    setSelected(row);
    setForm(initialForm(module, row));
    setDirtyFields(new Set());
    setFormFiles({});
  }

  function resetCreate() {
    setSelected(null);
    setForm(initialForm(module));
    setDirtyFields(new Set());
    setFormFiles({});
    setFormUploadExtras(
      Object.fromEntries(
        (module.uploads || []).map((action) => [
          action.key,
          initialForm(emptyModule(action.extraFields || []), null),
        ]),
      ),
    );
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (module.readOnly) {
      setStatus("This endpoint is read-only in admin.");
      return;
    }
    setBusy(true);
    try {
      const fields = selected ? module.fields.filter((field) => dirtyFields.has(field.name)) : module.fields;
      const payload = parsePayload(fields, form, Boolean(selected));
      const hasUploads = Object.values(formFiles).some((files) => files.length > 0);
      if (selected && !Object.keys(payload).length && !hasUploads) {
        setStatus("No changes to save.");
        return;
      }
      const path = selected ? module.updatePath?.(selected) : module.createPath;
      if (!path) throw new Error("Save endpoint is not configured.");
      const method = selected ? "PATCH" : "POST";
      let result =
        selected && !Object.keys(payload).length
          ? selected
          : await request<JsonRecord>(path, {
              method,
              body: JSON.stringify(payload),
            });
      if (selected && result && typeof result === "object") {
        result = { ...selected, ...result, ...payload };
      }
      if (result && typeof result === "object") {
        for (const action of module.uploads || []) {
          const files = formFiles[action.key] || [];
          if (!files.length) continue;
          result = await uploadActionFiles(
            action,
            result,
            files,
            formUploadExtras[action.key] || {},
            request,
          );
        }
      }
      setStatus(selected ? "Запись обновлена." : "Запись создана.");
      if (result && typeof result === "object") selectRow(result);
      setFormFiles({});
      await loadRows();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Ошибка сохранения.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(row: JsonRecord) {
    if (module.readOnly || !module.deletePath) {
      setStatus("Delete is not available for this endpoint.");
      return;
    }
    const name = String(row.slug || row.title || row.name || row.id);
    if (!window.confirm(`Удалить ${name}?`)) return;
    setBusy(true);
    try {
      await request(module.deletePath(row), { method: "DELETE" });
      if (selected?.[module.idField] === row[module.idField]) resetCreate();
      setStatus("Запись удалена.");
      await loadRows();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Ошибка удаления.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="link-row">
        {!module.readOnly ? (
          <button className="link-button" onClick={resetCreate}>
            Создать запись
          </button>
        ) : null}
        <button className="link-button" onClick={loadRows} disabled={busy}>
          Обновить таблицу
        </button>
        <a href={`/api/proxy${module.listPath}`} target="_blank" rel="noreferrer">
          Открыть endpoint
        </a>
      </div>

      {module.supportsMenuBrowser ? <MenuBrowser request={request} onDone={loadRows} /> : null}
      {module.supportsOrderAnalytics ? (
        <OrderAnalytics
          rows={rows}
          request={request}
          onSelect={selectRow}
          onRowsChange={setRows}
          onStatus={setStatus}
        />
      ) : null}

      <h2 className="section-title">Таблица: {module.tableName}</h2>
      <div className="toolbar">
        <label>
          Поиск в таблице ({rows.length})
          <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="LIKE '%'" />
        </label>
        <button onClick={loadRows} disabled={busy}>
          Поиск
        </button>
        <span className="muted">{module.description}</span>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Действия</th>
              <th>ID</th>
              {module.columns.map((column) => (
                <th key={column}>{column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filteredRows.map((row) => (
              <tr key={String(row[module.idField])}>
                <td>
                  <div className="row-actions">
                    <button className="link-button" onClick={() => selectRow(row)}>
                      выбрать
                    </button>
                    {!module.readOnly && module.deletePath ? (
                      <button className="link-button danger" onClick={() => remove(row)}>
                        удалить
                      </button>
                    ) : null}
                  </div>
                </td>
                <td>{compact(row[module.idField])}</td>
                {module.columns.map((column) => (
                  <td key={column}>{displayValue(row[column])}</td>
                ))}
              </tr>
            ))}
            {!filteredRows.length ? (
              <tr>
                <td colSpan={module.columns.length + 2} className="muted">
                  Нет данных.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div className={`panels ${module.readOnly ? "read-only-panels" : ""}`}>
        {!module.readOnly ? (
        <form onSubmit={save}>
          <fieldset>
            <legend>{selected ? `Изменить ${selected[module.idField]}` : "Создать запись"}</legend>
            <div className="form-grid">
              {module.fields.map((field) => (
                <FieldInput
                  key={field.name}
                  field={field}
                  value={form[field.name]}
                  onChange={(value) => {
                    setForm((current) => ({ ...current, [field.name]: value }));
                    setDirtyFields((current) => new Set(current).add(field.name));
                  }}
                  options={relationOptions[field.name]}
                />
              ))}
              {module.uploads?.map((action) => {
                const files = formFiles[action.key] || [];
                const names = files.map((file) => file.name).join(", ");

                return (
                  <div key={action.key} className="wide inline-upload">
                    <label>
                      {action.label}
                      <input
                        accept={action.accept}
                        multiple={action.multiple}
                        type="file"
                        onChange={(event) =>
                          setFormFiles((current) => ({
                            ...current,
                            [action.key]: toFiles(event.target.files),
                          }))
                        }
                      />
                    </label>
                    {action.extraFields?.length ? (
                      <div className="upload-fields">
                        {action.extraFields.map((field) => (
                          <FieldInput
                            key={field.name}
                            field={field}
                            value={formUploadExtras[action.key]?.[field.name]}
                            onChange={(value) =>
                              setFormUploadExtras((current) => ({
                                ...current,
                                [action.key]: {
                                  ...(current[action.key] || {}),
                                  [field.name]: value,
                                },
                              }))
                            }
                          />
                        ))}
                      </div>
                    ) : null}
                    {names ? <span className="small muted">{names}</span> : null}
                  </div>
                );
              })}
            </div>
            <div className="panel-actions">
              <button disabled={busy} type="submit">
                {selected ? "Сохранить" : "Создать"}
              </button>
              <button type="button" onClick={resetCreate}>
                Очистить
              </button>
            </div>
            <p className="status-line muted">{status}</p>
          </fieldset>
        </form>
        ) : null}

        <fieldset>
          <legend>Выбранная запись ({selected ? "1" : "0"})</legend>
          {selected ? (
            <>
              {module.uploads?.length ? (
                <div className="panel-actions">
                  {module.uploads.map((action) => (
                    <UploadControl
                      key={action.key}
                      action={action}
                      row={selected}
                      request={request}
                      onDone={async (record) => {
                        if (record) selectRow(record);
                        await loadRows();
                      }}
                    />
                  ))}
                </div>
              ) : null}
              {module.supportsStorySlides ? (
                <StorySlidesEditor
                  story={selected}
                  request={request}
                  onStoryChange={selectRow}
                  onDone={loadRows}
                />
              ) : null}
              {module.supportsBookingImages ? (
                <BookingImagesEditor
                  booking={selected}
                  request={request}
                  onBookingChange={selectRow}
                  onDone={loadRows}
                />
              ) : null}
              {module.supportsOrganizationTools ? (
                <OrganizationTools organization={selected} request={request} />
              ) : null}
              {module.supportsOrderTools ? (
                <OrderTools order={selected} request={request} onOrderChange={selectRow} />
              ) : null}
              {module.details?.map((detail) => (
                <div key={detail.name}>
                  <p className="small muted">{detail.label}</p>
                  <pre className="record-json">{stringify(selected[detail.name])}</pre>
                </div>
              ))}
              <p className="small muted">Raw</p>
              <pre className="record-json">{JSON.stringify(selected, null, 2)}</pre>
            </>
          ) : (
            <p className="muted">Выберите строку таблицы для редактирования, загрузки файлов и просмотра JSON.</p>
          )}
        </fieldset>
      </div>
    </>
  );
}

export function AdminApp() {
  const [session, setSession] = useState<StoredSession | null>(null);
  const [activeKey, setActiveKey] = useState(adminModules[0].key);
  const [menuOpen, setMenuOpen] = useState(false);
  const activeModule = adminModules.find((module) => module.key === activeKey) || adminModules[0];

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSession(loadSession());
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const onExpired = () => setSession(null);
    window.addEventListener(AUTH_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, onExpired);
  }, []);

  const request = useCallback<Requester>(
    (path, options) => apiRequestWithRefresh(session, setSession, path, options),
    [session],
  );

  async function doRefresh() {
    if (!session) return;
    try {
      setSession(await refreshSession(session));
    } catch {
      clearSession();
      setSession(null);
    }
  }

  async function logout() {
    if (session) {
      try {
        await apiRequest(session, "/api/v1/auth/logout", {
          auth: false,
          method: "POST",
          body: JSON.stringify({ device_id: session.device_id, refresh_token: session.refresh_token }),
        });
      } catch {
        // Local logout should still work when the API is unavailable.
      }
    }
    clearSession();
    setSession(null);
  }

  if (!session) return <LoginScreen onLogin={setSession} />;

  return (
    <main className="admin-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">▦</span>
          <span className="brand-title">MangalClubs</span>
          <span className="brand-version">0.1</span>
          <button className="mobile-menu" onClick={() => setMenuOpen((value) => !value)}>
            меню
          </button>
        </div>
        <div className={`side-block collapsible ${menuOpen ? "open" : ""}`}>
          <div className="side-row">
            <span>User:</span>
            <span className="small">{session.user.email || session.user.id}</span>
          </div>
        </div>
        <div className={`side-block collapsible ${menuOpen ? "open" : ""}`}>
          <div className="side-nav">
            <button className="nav-item" onClick={() => setActiveKey("organizations")}>
              SQL-запрос
            </button>
            <button className="nav-item" onClick={doRefresh}>
              Обновить токен
            </button>
            <button className="nav-item danger" onClick={logout}>
              Выход
            </button>
          </div>
        </div>
        <div className={`side-block collapsible ${menuOpen ? "open" : ""}`}>
          <div className="side-nav">
            {adminModules.map((module) => (
              <button
                key={module.key}
                className={`nav-item ${module.key === activeKey ? "active" : ""}`}
                onClick={() => {
                  setActiveKey(module.key);
                  setMenuOpen(false);
                }}
              >
                выбрать {module.tableName}
              </button>
            ))}
          </div>
        </div>
      </aside>

      <section className="content">
        <header className="topbar">
          <h1>Схема: public</h1>
          <div className="top-actions">
            <span className="pill">{activeModule.title}</span>
            <span className="muted">admin</span>
          </div>
        </header>
        <div className="workspace">
          <ModuleView key={activeModule.key} module={activeModule} request={request} />
        </div>
      </section>
    </main>
  );
}
