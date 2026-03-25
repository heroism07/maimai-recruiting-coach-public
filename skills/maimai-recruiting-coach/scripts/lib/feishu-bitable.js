import { readFile } from "node:fs/promises";
import { basename } from "node:path";

const FEISHU_OPEN_API = "https://open.feishu.cn/open-apis";

function ensureFetch() {
  if (typeof fetch !== "function") {
    throw new Error("当前 Node 版本不支持 fetch，请升级到 Node.js 18+");
  }
}

async function requestJson(url, options) {
  ensureFetch();
  const response = await fetch(url, options);
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`飞书接口返回非 JSON，HTTP ${response.status}`);
  }

  if (!response.ok) {
    throw new Error(`飞书接口请求失败，HTTP ${response.status}，响应: ${JSON.stringify(payload)}`);
  }
  if (payload.code !== 0) {
    throw new Error(`飞书接口业务失败，code=${payload.code}，msg=${payload.msg ?? "unknown"}`);
  }
  return payload;
}

async function requestJsonWithAuth(url, options, tenantAccessToken) {
  const headers = {
    ...(options?.headers ?? {}),
    Authorization: `Bearer ${tenantAccessToken}`
  };
  return requestJson(url, {
    ...options,
    headers
  });
}

export function parseBitableUrl(url) {
  const parsed = new URL(url);
  const appTokenMatch = parsed.pathname.match(/\/base\/([^/]+)/i);
  const appToken = appTokenMatch ? appTokenMatch[1] : "";
  const tableId = parsed.searchParams.get("table") ?? "";
  const viewId = parsed.searchParams.get("view") ?? "";
  return { appToken, tableId, viewId };
}

export async function getTenantAccessToken(appId, appSecret) {
  const payload = await requestJson(`${FEISHU_OPEN_API}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    },
    body: JSON.stringify({
      app_id: appId,
      app_secret: appSecret
    })
  });
  return payload.tenant_access_token;
}

export async function listTableFields(tenantAccessToken, appToken, tableId) {
  const fields = [];
  let pageToken = "";
  let hasMore = true;

  while (hasMore) {
    const query = new URLSearchParams({
      page_size: "200"
    });
    if (pageToken) {
      query.set("page_token", pageToken);
    }

    const payload = await requestJsonWithAuth(
      `${FEISHU_OPEN_API}/bitable/v1/apps/${appToken}/tables/${tableId}/fields?${query.toString()}`,
      { method: "GET" },
      tenantAccessToken
    );

    const pageItems = payload.data?.items ?? [];
    for (const item of pageItems) {
      fields.push(item);
    }
    hasMore = Boolean(payload.data?.has_more);
    pageToken = payload.data?.page_token ?? "";
  }

  return fields;
}

export async function createTableField(
  tenantAccessToken,
  appToken,
  tableId,
  fieldName,
  fieldType = 1,
  property = null
) {
  const requestBody = {
    field_name: fieldName,
    type: fieldType
  };
  if (property && typeof property === "object") {
    requestBody.property = property;
  }

  const payload = await requestJsonWithAuth(
    `${FEISHU_OPEN_API}/bitable/v1/apps/${appToken}/tables/${tableId}/fields`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8"
      },
      body: JSON.stringify(requestBody)
    },
    tenantAccessToken
  );
  return payload.data?.field ?? null;
}

export async function updateTableField(
  tenantAccessToken,
  appToken,
  tableId,
  fieldId,
  { fieldName, type, property } = {}
) {
  if (!fieldId) {
    throw new Error("updateTableField 缺少 fieldId");
  }
  const requestBody = {};
  if (fieldName) {
    requestBody.field_name = fieldName;
  }
  if (Number.isFinite(Number(type))) {
    requestBody.type = Number(type);
  }
  if (property && typeof property === "object") {
    requestBody.property = property;
  }
  if (Object.keys(requestBody).length === 0) {
    throw new Error("updateTableField 缺少可更新字段");
  }

  const payload = await requestJsonWithAuth(
    `${FEISHU_OPEN_API}/bitable/v1/apps/${appToken}/tables/${tableId}/fields/${fieldId}`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json; charset=utf-8"
      },
      body: JSON.stringify(requestBody)
    },
    tenantAccessToken
  );
  return payload.data?.field ?? null;
}

export async function batchCreateRecords(tenantAccessToken, appToken, tableId, records, batchSize = 100) {
  const created = await batchCreateRecordsDetailed(
    tenantAccessToken,
    appToken,
    tableId,
    records,
    batchSize
  );
  return created.length;
}

export async function batchCreateRecordsDetailed(
  tenantAccessToken,
  appToken,
  tableId,
  records,
  batchSize = 100
) {
  const chunks = [];
  for (let i = 0; i < records.length; i += batchSize) {
    chunks.push(records.slice(i, i + batchSize));
  }

  const createdRecords = [];
  for (const chunk of chunks) {
    const payload = await requestJsonWithAuth(
      `${FEISHU_OPEN_API}/bitable/v1/apps/${appToken}/tables/${tableId}/records/batch_create`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8"
        },
        body: JSON.stringify({
          records: chunk.map((fields) => ({ fields }))
        })
      },
      tenantAccessToken
    );
    const items = payload.data?.records ?? [];
    if (Array.isArray(items) && items.length > 0) {
      createdRecords.push(...items);
    } else {
      createdRecords.push(...chunk.map(() => ({ record_id: "", fields: {} })));
    }
  }

  return createdRecords;
}

export async function listTableRecords(tenantAccessToken, appToken, tableId, options = {}) {
  const records = [];
  let pageToken = "";
  let hasMore = true;
  const pageSize = Number(options.pageSize ?? 200);
  const viewId = options.viewId ?? "";

  while (hasMore) {
    const query = new URLSearchParams({
      page_size: String(pageSize)
    });
    if (pageToken) {
      query.set("page_token", pageToken);
    }
    if (viewId) {
      query.set("view_id", viewId);
    }

    const payload = await requestJsonWithAuth(
      `${FEISHU_OPEN_API}/bitable/v1/apps/${appToken}/tables/${tableId}/records?${query.toString()}`,
      { method: "GET" },
      tenantAccessToken
    );

    const pageItems = payload.data?.items ?? [];
    for (const item of pageItems) {
      records.push(item);
    }
    hasMore = Boolean(payload.data?.has_more);
    pageToken = payload.data?.page_token ?? "";
  }

  return records;
}

export async function updateRecordFields(tenantAccessToken, appToken, tableId, recordId, fields) {
  await requestJsonWithAuth(
    `${FEISHU_OPEN_API}/bitable/v1/apps/${appToken}/tables/${tableId}/records/batch_update`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8"
      },
      body: JSON.stringify({
        records: [
          {
            record_id: recordId,
            fields
          }
        ]
      })
    },
    tenantAccessToken
  );
}

export async function uploadFileToBitable(tenantAccessToken, appToken, filePath, options = {}) {
  ensureFetch();
  const fileBuffer = await readFile(filePath);
  if (!fileBuffer.length) {
    throw new Error(`附件文件为空，无法上传: ${filePath}`);
  }

  const fileName = (options.fileName ?? basename(filePath)).trim() || basename(filePath);
  const parentType = options.parentType ?? "bitable_file";
  const parentNode = options.parentNode ?? appToken;

  const form = new FormData();
  form.append("file_name", fileName);
  form.append("parent_type", parentType);
  form.append("parent_node", parentNode);
  form.append("size", String(fileBuffer.length));
  form.append("file", new Blob([fileBuffer]), fileName);

  const response = await fetch(`${FEISHU_OPEN_API}/drive/v1/medias/upload_all`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tenantAccessToken}`
    },
    body: form
  });

  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`飞书上传接口返回非 JSON，HTTP ${response.status}`);
  }

  if (!response.ok) {
    throw new Error(`飞书上传接口请求失败，HTTP ${response.status}，响应: ${JSON.stringify(payload)}`);
  }
  if (payload.code !== 0) {
    throw new Error(`飞书上传接口业务失败，code=${payload.code}，msg=${payload.msg ?? "unknown"}`);
  }

  const fileToken = payload.data?.file_token;
  if (!fileToken) {
    throw new Error(`飞书上传成功但未返回 file_token: ${JSON.stringify(payload.data ?? {})}`);
  }
  return {
    file_token: fileToken,
    file_name: fileName,
    size: fileBuffer.length
  };
}
