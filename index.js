import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import crypto from "crypto";

const app = express();
app.use(cors());
app.use(express.json());

const MANGOFY_URL = "https://checkout.mangofy.com.br/api/v1/payment";

// variáveis que você colocou na Railway
const STORE_CODE_HEADER = process.env.MANGOFY_STORE_CODE_HEADER;
const AUTH_HEADER = process.env.MANGOFY_AUTHORIZATION;
const STORE_CODE_BODY = process.env.MANGOFY_STORE_CODE_BODY;

// URL de postback da Mangofy -> SEU BACKEND
const POSTBACK_URL =
  process.env.POSTBACK_URL ||
  "https://nodejs-production-8418.up.railway.app/api/webhookmangofy";

// UTMify
const UTMIFY_URL = "https://api.utmify.com.br/api-credentials/orders";
const UTMIFY_API_TOKEN = "o3TW8mrJa7xcrr19toAWtKwWE3Hf57xyhGpk";

// 🔥 TikTok Events API 2.0
const TIKTOK_EVENTS_API_URL =
  process.env.TIKTOK_EVENTS_API_URL ||
  "https://business-api.tiktok.com/open_api/v1.3/event/track/";
const TIKTOK_PIXEL_CODE =
  process.env.TIKTOK_PIXEL_CODE || "D31JEHRC77U7TGIRBPQ0";
const TIKTOK_ACCESS_TOKEN = process.env.TIKTOK_ACCESS_TOKEN;
const TIKTOK_TEST_EVENT_CODE = process.env.TIKTOK_TEST_EVENT_CODE || null;

// 🔥 Facebook Conversions API
const FACEBOOK_PIXEL_ID = process.env.FACEBOOK_PIXEL_ID;
const FACEBOOK_ACCESS_TOKEN = process.env.FACEBOOK_ACCESS_TOKEN;
const FACEBOOK_TEST_EVENT_CODE =
  process.env.FACEBOOK_TEST_EVENT_CODE || null;
const FACEBOOK_GRAPH_API_URL =
  process.env.FACEBOOK_GRAPH_API_URL ||
  "https://graph.facebook.com/v19.0";

// dados fixos do cliente (fallback)
const FIXED_CUSTOMER = {
  email: "thiagopagamentoss@gmail.com",
  name: "THIAGO MATIAS SOUZA",
  document: "70116952148",
  phone: "31993360332"
};

// memória simples pra front saber status do pagamento
// paymentStatus[payment_code] = { status, amount, utms }
const paymentStatus = {};

app.get("/", (req, res) => {
  res.json({ ok: true, msg: "API da Railway está rodando 🚀" });
});

/**
 * Helper: converte valor "20.00" ou número para centavos (integer)
 */
function toCents(value) {
  if (value == null) return null;
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const num = parseFloat(value.replace(",", "."));
    if (Number.isNaN(num)) return null;
    return Math.round(num * 100);
  }
  return null;
}

/**
 * Converte valor em centavos (string ou number) para inteiro
 * sem mexer na escala. Ex.: "2000" -> 2000
 */
function normalizeCentsInt(value) {
  if (value == null) return null;
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const n = parseInt(value, 10);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

/**
 * Retorna data/hora atual em UTC no formato "YYYY-MM-DD HH:MM:SS"
 */
function nowUtcString() {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

/**
 * SHA256 helper
 */
function sha256Lower(value) {
  if (!value) return null;
  return crypto
    .createHash("sha256")
    .update(String(value).trim().toLowerCase())
    .digest("hex");
}

/**
 * Normaliza telefone para formato E.164 BR (ex.: 5531999999999)
 */
function normalizePhoneE164BR(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, "");
  if (!digits) return null;
  if (!digits.startsWith("55")) {
    if (digits.length <= 11) {
      return "55" + digits;
    }
  }
  return digits;
}

/**
 * Extrai IP do header x-forwarded-for ou string múltipla
 */
function extractClientIp(raw) {
  if (!raw) return "";
  if (Array.isArray(raw)) raw = raw[0];
  const str = String(raw);
  return str.split(",")[0].trim();
}

/**
 * Monta payload para TikTok Events API 2.0
 */
function buildTikTokEventPayload({
  eventName,
  eventId,
  valueInCents,
  currency = "BRL",
  utms = {},
  ip,
  userAgent,
  customer = {},
  pageUrl,
  referrer,
  eventTime
}) {
  const value =
    typeof valueInCents === "number" && !Number.isNaN(valueInCents)
      ? valueInCents / 100
      : null;

  const ts =
    typeof eventTime === "number"
      ? eventTime
      : Math.floor(Date.now() / 1000);

  const hashedEmail = customer.email ? sha256Lower(customer.email) : null;
  const hashedPhone = customer.phone ? sha256Lower(customer.phone) : null;
  const hashedExternalId = customer.document
    ? sha256Lower(String(customer.document))
    : null;

  const user = {};
  if (hashedExternalId) user.external_id = hashedExternalId;
  if (hashedEmail) user.email = hashedEmail;
  if (hashedPhone) user.phone = hashedPhone;

  if (utms.ttclid || utms.ttc_id || utms.tt_clickid) {
    user.ttclid = String(
      utms.ttclid || utms.ttc_id || utms.tt_clickid
    );
  }

  const utmProps = {};
  ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"].forEach(
    (k) => {
      if (utms && utms[k]) {
        utmProps[k] = String(utms[k]);
      }
    }
  );

  const properties = {
    ...utmProps
  };

  if (value != null) {
    properties.value = value;
    properties.currency = currency;
    properties.content_type = "product";
    if (eventId) {
      properties.content_id = eventId;
    }
  }

  const page = {};
  if (pageUrl) page.url = pageUrl;
  if (referrer) page.referrer = referrer || null;

  return {
    event_source: "web",
    event_source_id: TIKTOK_PIXEL_CODE,
    data: [
      {
        event: eventName,
        event_time: ts,
        event_id: eventId || null,
        user,
        properties,
        page
      }
    ]
  };
}

/**
 * Monta payload para Facebook Conversions API
 */
function buildFacebookEventPayload({
  eventName,
  eventId,
  valueInCents,
  currency = "BRL",
  utms = {},
  ip,
  userAgent,
  customer = {},
  pageUrl,
  eventTime
}) {
  const value =
    typeof valueInCents === "number" && !Number.isNaN(valueInCents)
      ? valueInCents / 100
      : null;

  const ts =
    typeof eventTime === "number"
      ? eventTime
      : Math.floor(Date.now() / 1000);

  const emailHashed = customer.email ? sha256Lower(customer.email) : null;
  const phoneNorm = normalizePhoneE164BR(customer.phone);
  const phoneHashed = phoneNorm ? sha256Lower(phoneNorm) : null;
  const externalIdHashed = customer.document
    ? sha256Lower(String(customer.document))
    : null;

  const user_data = {};
  if (emailHashed) user_data.em = [emailHashed]; // array de hashes
  if (phoneHashed) user_data.ph = [phoneHashed]; // array de hashes
  if (externalIdHashed) user_data.external_id = externalIdHashed;
  if (ip) user_data.client_ip_address = ip;
  if (userAgent) user_data.client_user_agent = userAgent;

  // fbclid / fbp se vierem do front (dentro de utms)
  if (utms.fbclid) {
    user_data.fbc = `fb.1.${ts}.${String(utms.fbclid)}`;
  }
  if (utms.fbp) {
    user_data.fbp = String(utms.fbp);
  }

  const custom_data = {};
  if (value != null) {
    custom_data.value = value;
    custom_data.currency = currency;
    custom_data.content_type = "product";
    if (eventId) {
      custom_data.content_ids = [eventId];
      custom_data.contents = [
        {
          id: eventId,
          quantity: 1,
          item_price: value
        }
      ];
    }
  }

  ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"].forEach(
    (k) => {
      if (utms && utms[k]) {
        custom_data[k] = String(utms[k]);
      }
    }
  );

  const event = {
    event_name: eventName,
    event_time: ts,
    event_id: eventId || undefined,
    action_source: "website",
    user_data
  };

  // sempre mandar uma URL de origem (usa a do webhook se vier, senão fallback fixo)
  event.event_source_url =
    pageUrl || "https://institutomaos.lat/vakinhaoficial/";

  if (Object.keys(custom_data).length > 0) {
    event.custom_data = custom_data;
  }

  const payload = {
    data: [event]
  };

  if (FACEBOOK_TEST_EVENT_CODE) {
    payload.test_event_code = FACEBOOK_TEST_EVENT_CODE;
  }

  return payload;
}

/**
 * Envia evento pro TikTok Events API
 */
async function sendTikTokEvent(payload) {
  if (!TIKTOK_PIXEL_CODE || !TIKTOK_ACCESS_TOKEN) {
    console.warn(
      "[TIKTOK] Pixel code ou Access Token não configurados. Evento não enviado."
    );
    return;
  }

  try {
    if (TIKTOK_TEST_EVENT_CODE) {
      payload.test_event_code = TIKTOK_TEST_EVENT_CODE;
    }

    console.log("[TIKTOK ENVIANDO]", JSON.stringify(payload, null, 2));

    const res = await fetch(TIKTOK_EVENTS_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Access-Token": TIKTOK_ACCESS_TOKEN
      },
      body: JSON.stringify(payload)
    });

    const text = await res.text();

    let evtName = "unknown";
    if (payload && payload.data && payload.data[0] && payload.data[0].event) {
      evtName = payload.data[0].event;
    }

    console.log("[TIKTOK RESPOSTA]", evtName, res.status, text.slice(0, 500));
  } catch (err) {
    console.error("Erro ao enviar evento para TikTok:", err);
  }
}

/**
 * Envia evento para Facebook Conversions API
 */
async function sendFacebookEvent(payload) {
  if (!FACEBOOK_PIXEL_ID || !FACEBOOK_ACCESS_TOKEN) {
    console.warn(
      "[FACEBOOK] Pixel ID ou Access Token não configurados. Evento não enviado."
    );
    return;
  }

  try {
    console.log("[FACEBOOK ENVIANDO]", JSON.stringify(payload, null, 2));

    const url = `${FACEBOOK_GRAPH_API_URL}/${FACEBOOK_PIXEL_ID}/events?access_token=${FACEBOOK_ACCESS_TOKEN}`;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const text = await res.text();

    let evtName = "unknown";
    if (
      payload &&
      payload.data &&
      payload.data[0] &&
      payload.data[0].event_name
    ) {
      evtName = payload.data[0].event_name;
    }

    console.log(
      "[FACEBOOK RESPOSTA]",
      evtName,
      res.status,
      text.slice(0, 500)
    );
  } catch (err) {
    console.error("Erro ao enviar evento para Facebook:", err);
  }
}

/**
 * Envia uma ordem para o UTMify (fire-and-forget)
 */
async function sendToUtmify(order) {
  try {
    console.log("[UTMIFY ENVIANDO]", JSON.stringify(order, null, 2));
    const res = await fetch(UTMIFY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-token": UTMIFY_API_TOKEN
      },
      body: JSON.stringify(order)
    });

    const text = await res.text();
    console.log("[UTMIFY RESPOSTA]", res.status, text);
  } catch (err) {
    console.error("Erro ao enviar para UTMify:", err);
  }
}

/**
 * Constrói o payload para o UTMify a partir do webhook da Mangofy
 */
function buildUtmifyOrderFromWebhook(body) {
  let status = "waiting_payment";
  if (body.payment_status === "approved") {
    status = "paid";
  } else if (body.payment_status === "refunded") {
    status = "refunded";
  }

  const createdAt = nowUtcString();
  const approvedDate = status === "paid" ? nowUtcString() : null;
  const refundedAt = status === "refunded" ? nowUtcString() : null;

  const paymentAmountCents = toCents(body.payment_amount);
  const saleAmountCents = toCents(body.sale_amount);
  const commissionAmountCents = toCents(body.commission_amount);

  const totalPriceInCents =
    typeof saleAmountCents === "number" && !Number.isNaN(saleAmountCents)
      ? saleAmountCents
      : typeof paymentAmountCents === "number" &&
        !Number.isNaN(paymentAmountCents)
      ? paymentAmountCents
      : null;

  if (!totalPriceInCents) {
    console.warn(
      "[UTMIFY] Webhook sem payment_amount/sale_amount. Ignorando envio. payment_code:",
      body.payment_code
    );
    return null;
  }

  const gatewayFeeInCents =
    commissionAmountCents != null && !Number.isNaN(commissionAmountCents)
      ? totalPriceInCents - commissionAmountCents
      : 0;

  const metadata = body.metadata || {};
  const customer = body.customer || {};

  const products =
    Array.isArray(body.products) && body.products.length > 0
      ? body.products.map((p) => ({
          id: p.id || body.payment_code,
          name: p.name || "Produto",
          planId: p.plan_id || null,
          planName: p.plan_name || null,
          quantity: p.quantity || 1,
          priceInCents: totalPriceInCents
        }))
      : [
          {
            id: body.payment_code,
            name: "Depósito Raspagreen",
            planId: null,
            planName: null,
            quantity: 1,
            priceInCents: totalPriceInCents
          }
        ];

  const trackingParameters = {
    src: metadata.src || null,
    sck: metadata.sck || null,
    utm_source: metadata.utm_source || null,
    utm_campaign: metadata.utm_campaign || null,
    utm_medium: metadata.utm_medium || null,
    utm_content: metadata.utm_content || null,
    utm_term: metadata.utm_term || null
  };

  return {
    orderId: body.payment_code,
    platform: "Mangofy",
    paymentMethod: body.payment_method || "pix",
    status,
    createdAt,
    approvedDate,
    refundedAt,
    customer: {
      name: customer.name || "",
      email: customer.email || "",
      phone: String(customer.phone || ""),
      document: String(customer.document || ""),
      country: "BR",
      ip: ""
    },
    products,
    trackingParameters,
    commission: {
      totalPriceInCents,
      gatewayFeeInCents,
      userCommissionInCents: commissionAmountCents || totalPriceInCents
    },
    isTest: false
  };
}

/**
 * Geração do pagamento PIX
 */
app.post("/api/pix", async (req, res) => {
  try {
    const valor =
      req.body.payment_amount || req.body.valor || req.body.amount;

    if (!valor) {
      return res
        .status(400)
        .json({ error: "valor (em centavos) é obrigatório" });
    }

    const utmsRaw = req.body.utms || {};

    const metadataUtms = {
      utm_source: utmsRaw.utm_source ? String(utmsRaw.utm_source) : undefined,
      utm_medium: utmsRaw.utm_medium ? String(utmsRaw.utm_medium) : undefined,
      utm_campaign: utmsRaw.utm_campaign
        ? String(utmsRaw.utm_campaign)
        : undefined,
      utm_content: utmsRaw.utm_content
        ? String(utmsRaw.utm_content)
        : undefined,
      utm_term: utmsRaw.utm_term ? String(utmsRaw.utm_term) : undefined
    };

    Object.keys(metadataUtms).forEach((k) => {
      if (metadataUtms[k] === undefined) delete metadataUtms[k];
    });

    const ip = extractClientIp(
      req.headers["x-forwarded-for"] || req.socket.remoteAddress || ""
    );

    const userAgent = req.headers["user-agent"] || "";

    const pageReferrer = req.headers["referer"] || null;
    const pageUrl = pageReferrer || null;

    const externalCode = `dep_${Date.now()}`;
    const eventIdFromFront = req.body.event_id;
    const eventId = eventIdFromFront || externalCode;

    // junta tudo que é UTM / IDs em um objeto só
    const allUtms = {
      ...utmsRaw,
      ...metadataUtms
    };

    const payload = {
      store_code: STORE_CODE_BODY,
      external_code: externalCode,
      payment_method: "pix",
      payment_amount: valor,
      pix: {
        expires_in_days: 1
      },
      payment_format: "regular",
      installments: 1,
      postback_url: POSTBACK_URL,
      items: [
        {
          code: `DEP-${externalCode}`,
          amount: 1,
          price: valor
        }
      ],
      customer: {
        email: FIXED_CUSTOMER.email,
        name: FIXED_CUSTOMER.name,
        document: FIXED_CUSTOMER.document,
        phone: FIXED_CUSTOMER.phone,
        ip
      },
      // grava ttclid, fbclid, utms e page_url direto na metadata
      metadata: {
        ...metadataUtms,
        ...utmsRaw,
        utms: allUtms,
        ip,
        user_agent: userAgent,
        page_url: pageUrl,
        event_id: eventId
      },
      extra: {
        cybersource_fingerprint: "",
        seon_fingerprint: "",
        utms: allUtms,
        userAgent,
        browser: "",
        metadata: {
          ...metadataUtms,
          ...utmsRaw,
          utms: allUtms,
          ip,
          user_agent: userAgent,
          page_url: pageUrl,
          event_id: eventId
        }
      }
    };

    console.log("[PAYLOAD MANGOFY]", JSON.stringify(payload, null, 2));

    const mgRes = await fetch(MANGOFY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "Store-Code": STORE_CODE_HEADER,
        Authorization: AUTH_HEADER
      },
      body: JSON.stringify(payload)
    });

    const data = await mgRes.json();
    console.log("[RESPOSTA MANGOFY]", mgRes.status, data);

    // guarda status inicial em memória pra front poder consultar
    if (data && data.payment_code) {
      paymentStatus[data.payment_code] = {
        status: data.payment_status || "pending",
        amount: valor,
        utms: allUtms
      };
    }

    // 🔔 TIKTOK: AddToCart
    try {
      const valueInCents = normalizeCentsInt(valor);
      const tikTokPayload = buildTikTokEventPayload({
        eventName: "AddToCart",
        eventId,
        valueInCents,
        currency: "BRL",
        utms: allUtms,
        ip,
        userAgent,
        customer: FIXED_CUSTOMER,
        pageUrl,
        referrer: pageReferrer
      });

      sendTikTokEvent(tikTokPayload).catch((err) => {
        console.error("[TIKTOK] Erro async AddToCart:", err);
      });
    } catch (err) {
      console.error("[TIKTOK] Erro ao montar evento AddToCart:", err);
    }

    // 🔔 FACEBOOK: AddToCart
    try {
      const valueInCents = normalizeCentsInt(valor);
      const fbPayload = buildFacebookEventPayload({
        eventName: "AddToCart",
        eventId,
        valueInCents,
        currency: "BRL",
        utms: allUtms,
        ip,
        userAgent,
        customer: FIXED_CUSTOMER,
        pageUrl
      });

      sendFacebookEvent(fbPayload).catch((err) => {
        console.error("[FACEBOOK] Erro async AddToCart:", err);
      });
    } catch (err) {
      console.error("[FACEBOOK] Erro ao montar evento AddToCart:", err);
    }

    // devolve a resposta da Mangofy pro front (inclui payment_code)
    res.status(mgRes.status).json(data);
  } catch (err) {
    console.error("Erro ao gerar pagamento:", err);
    res.status(500).json({ error: "Erro ao gerar pagamento" });
  }
});

/**
 * Endpoint para o front consultar status do pagamento
 * GET /api/payment-status?payment_code=...
 */
app.get("/api/payment-status", (req, res) => {
  const code = req.query.payment_code;
  if (!code) {
    return res.status(400).json({ error: "payment_code é obrigatório" });
  }

  const info = paymentStatus[code];
  if (!info) {
    return res.json({ status: "unknown" });
  }

  res.json(info);
});

/**
 * Webhook da Mangofy
 */
app.post("/api/webhookmangofy", async (req, res) => {
  try {
    const body = req.body;
    console.log("[WEBHOOK MANGOFY RECEBIDO]", JSON.stringify(body, null, 2));

    const utmifyOrder = buildUtmifyOrderFromWebhook(body);

    if (utmifyOrder) {
      sendToUtmify(utmifyOrder).catch((err) => {
        console.error("Erro no envio assíncrono para UTMify:", err);
      });
    } else {
      console.log("[UTMIFY] Pedido ignorado (sem valor).");
    }

    // atualiza status em memória
    if (body.payment_code) {
      const prev = paymentStatus[body.payment_code] || {};
      paymentStatus[body.payment_code] = {
        ...prev,
        status: body.payment_status || prev.status || "unknown",
        amount: body.payment_amount || prev.amount,
        utms:
          (body.metadata && body.metadata.utms) ||
          body.metadata ||
          prev.utms
      };
    }

    // 🔔 TIKTOK & FACEBOOK: Purchase quando pagamento aprovado
    try {
      if (body.payment_status === "approved") {
        // só manda se tiver valor
        const cents = toCents(body.payment_amount || body.sale_amount);
        if (!cents) {
          console.warn(
            "[PIXEL] Webhook approved sem payment_amount/sale_amount. Ignorando Purchase. payment_code:",
            body.payment_code
          );
        } else {
          const valueInCents = cents;

          const metadata = body.metadata || {};
          const utmsFromMetadata =
            metadata.utms && typeof metadata.utms === "object"
              ? metadata.utms
              : metadata;

          const customerFromWebhook = body.customer || {};

          const eventId =
            metadata.event_id ||
            (metadata.metadata && metadata.metadata.event_id) ||
            body.payment_code ||
            body.external_code ||
            `pay_${Date.now()}`;

          const ip = extractClientIp(metadata.ip || "");
          const userAgent = metadata.user_agent || "";
          const pageUrl = metadata.page_url || null;

          // TikTok Purchase
          const tikTokPayload = buildTikTokEventPayload({
            eventName: "Purchase",
            eventId,
            valueInCents,
            currency: "BRL",
            utms: utmsFromMetadata,
            ip,
            userAgent,
            customer: {
              email: customerFromWebhook.email || FIXED_CUSTOMER.email,
              phone: customerFromWebhook.phone || FIXED_CUSTOMER.phone,
              document:
                customerFromWebhook.document || FIXED_CUSTOMER.document
            },
            pageUrl: null,
            referrer: null
          });

          sendTikTokEvent(tikTokPayload).catch((err) => {
            console.error("[TIKTOK] Erro async Purchase:", err);
          });

          // Facebook Purchase
          const fbPayload = buildFacebookEventPayload({
            eventName: "Purchase",
            eventId,
            valueInCents,
            currency: "BRL",
            utms: utmsFromMetadata,
            ip,
            userAgent,
            customer: {
              email: customerFromWebhook.email || FIXED_CUSTOMER.email,
              phone: customerFromWebhook.phone || FIXED_CUSTOMER.phone,
              document:
                customerFromWebhook.document || FIXED_CUSTOMER.document
            },
            pageUrl
          });

          sendFacebookEvent(fbPayload).catch((err) => {
            console.error("[FACEBOOK] Erro async Purchase:", err);
          });
        }
      }
    } catch (err) {
      console.error("[PIXEL] Erro ao montar/enviar Purchase:", err);
    }

    res.status(200).json({ received: true });
  } catch (err) {
    console.error("Erro no webhook Mangofy:", err);
    res.status(200).json({ received: true, error: true });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
