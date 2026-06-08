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

const slideCreateFields: AdminField[] = [
  { name: "title", label: "Title", type: "text", emptyAsNull: true },
  { name: "caption", label: "Caption", type: "textarea", emptyAsNull: true, wide: true },
  { name: "duration_seconds", label: "Duration seconds", type: "number", parser: "integer", emptyAsNull: true },
  { name: "sort_order", label: "Sort", type: "number", parser: "integer", defaultValue: 0 },
  { name: "is_active", label: "Active", type: "checkbox", defaultValue: true },
];

const slideUpdateFields: AdminField[] = [
  { name: "url", label: "URL", type: "text", emptyAsNull: true, wide: true },
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

function compact(value: unknown) {
  if (value === null || value === undefined || value === "") return <span className="muted">NULL</span>;
  if (typeof value === "boolean") return value ? <span className="ok">true</span> : <span className="danger">false</span>;
  if (Array.isArray(value)) return <span>{value.length} items</span>;
  if (typeof value === "object") return <span>{JSON.stringify(value)}</span>;
  const text = String(value);
  if (text.startsWith("http")) {
    return (
      <a href={text} target="_blank" rel="noreferrer">
        {text.length > 42 ? `${text.slice(0, 39)}...` : text}
      </a>
    );
  }
  return text.length > 64 ? `${text.slice(0, 61)}...` : text;
}

function initialForm(module: AdminModule, row?: JsonRecord | null): FormState {
  return module.fields.reduce<FormState>((acc, field) => {
    if (row && Object.prototype.hasOwnProperty.call(row, field.name)) {
      acc[field.name] = field.type === "json" ? stringify(row[field.name]) : row[field.name];
      return acc;
    }
    if (row && field.name === "is_active" && Object.prototype.hasOwnProperty.call(row, "active")) {
      acc[field.name] = row.active;
      return acc;
    }
    if (row && field.name === "preview_url" && Object.prototype.hasOwnProperty.call(row, "previewImage")) {
      acc[field.name] = row.previewImage;
      return acc;
    }
    if (field.defaultValue !== undefined) {
      acc[field.name] = field.type === "json" ? stringify(field.defaultValue) : field.defaultValue;
      return acc;
    }
    acc[field.name] = field.type === "checkbox" ? false : "";
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
  return compact(value);
}

function parsePayload(fields: AdminField[], state: FormState, partial: boolean) {
  const payload: JsonRecord = {};

  for (const field of fields) {
    const raw = state[field.name];
    if (partial && (raw === "" || raw === undefined)) continue;

    if (field.type === "checkbox") {
      payload[field.name] = Boolean(raw);
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
        placeholder={field.placeholder}
        type={field.type}
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
      const form = new FormData();
      files.forEach((file) => form.append(action.fieldName, file));
      if (action.extraFields?.length) {
        const payload = parsePayload(action.extraFields, extraState, false);
        Object.entries(payload).forEach(([key, value]) => {
          if (value !== null && value !== undefined) form.append(key, String(value));
        });
      }
      const result = await request<JsonRecord>(action.path(row), {
        method: "POST",
        body: form,
      });
      setStatus("Готово");
      onDone();
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
      <label className="pill">
        {busy ? "..." : action.label}
        <input
          hidden
          accept={action.accept}
          multiple={action.multiple}
          type="file"
          onChange={(event) => upload(event.target.files)}
        />
      </label>
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

function ModuleView({ module, request }: { module: AdminModule; request: Requester }) {
  const [rows, setRows] = useState<JsonRecord[]>([]);
  const [relationOptions, setRelationOptions] = useState<Record<string, SelectOption[]>>({});
  const [selected, setSelected] = useState<JsonRecord | null>(null);
  const [form, setForm] = useState<FormState>(() => initialForm(module));
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
  }

  function resetCreate() {
    setSelected(null);
    setForm(initialForm(module));
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const payload = parsePayload(module.fields, form, Boolean(selected));
      const path = selected ? module.updatePath(selected) : module.createPath;
      const method = selected ? "PATCH" : "POST";
      const result = await request<JsonRecord>(path, {
        method,
        body: JSON.stringify(payload),
      });
      setStatus(selected ? "Запись обновлена." : "Запись создана.");
      if (result && typeof result === "object") selectRow(result);
      await loadRows();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Ошибка сохранения.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(row: JsonRecord) {
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
        <button className="link-button" onClick={resetCreate}>
          Создать запись
        </button>
        <button className="link-button" onClick={loadRows} disabled={busy}>
          Обновить таблицу
        </button>
        <a href={`/api/proxy${module.listPath}`} target="_blank" rel="noreferrer">
          Открыть endpoint
        </a>
      </div>

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
                    <button className="link-button danger" onClick={() => remove(row)}>
                      удалить
                    </button>
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

      <div className="panels">
        <form onSubmit={save}>
          <fieldset>
            <legend>{selected ? `Изменить ${selected[module.idField]}` : "Создать запись"}</legend>
            <div className="form-grid">
              {module.fields.map((field) => (
                <FieldInput
                  key={field.name}
                  field={field}
                  value={form[field.name]}
                  onChange={(value) => setForm((current) => ({ ...current, [field.name]: value }))}
                  options={relationOptions[field.name]}
                />
              ))}
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
                      onDone={loadRows}
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
