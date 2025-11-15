import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(cors());
app.use(express.json());

const MANGOFY_URL = "https://checkout.mangofy.com.br/api/v1/payment";

// variáveis que você colocou na Railway
const STORE_CODE_HEADER = process.env.MANGOFY_STORE_CODE_HEADER;
const AUTH_HEADER = process.env.MANGOFY_AUTHORIZATION;
const STORE_CODE_BODY = process.env.MANGOFY_STORE_CODE_BODY;

// URL de postback da Mangofy -> SEU BACKEND
// use env se quiser, senão usa direto a URL pública da Railway
const POSTBACK_URL =
  process.env.POSTBACK_URL ||
  "https://nodejs-production-8418.up.railway.app/api/webhookmangofy";

// UTMify
const UTMIFY_URL = "https://api.utmify.com.br/api-credentials/orders";
const UTMIFY_API_TOKEN = "ln4ADbicHelhM9oE23nylaKAedAkTEmD6n6R";

// dados fixos do cliente
const FIXED_CUSTOMER = {
  email: "thiagopagamentoss@gmail.com",
  name: "THIAGO MATIAS SOUZA",
  document: "70116952148",
  phone: "31993360332"
};

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
  // Mapeia status Mangofy -> status UTMify
  let status = "waiting_payment";
  if (body.payment_status === "approved") {
    status = "paid";
  } else if (body.payment_status === "refunded") {
    status = "refunded";
  }

  const createdAt =
    body.started_at ||
    body.created_at ||
    new Date().toISOString().replace("T", " ").slice(0, 19);

  const approvedDate =
    body.payment_status === "approved"
      ? (
          body.approved_at ||
          body.paid_at ||
          body.updated_at ||
          new Date().toISOString().replace("T", " ").slice(0, 19)
        )
      : null;

  const paymentAmountCents = toCents(body.payment_amount);
  const saleAmountCents = toCents(body.sale_amount);
  const commissionAmountCents = toCents(body.commission_amount);

  const totalPriceInCents = saleAmountCents || paymentAmountCents || 0;
  const gatewayFeeInCents =
    totalPriceInCents && commissionAmountCents != null
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
          priceInCents: paymentAmountCents
        }))
      : [
          {
            id: body.payment_code,
            name: "Depósito Raspagreen",
            planId: null,
            planName: null,
            quantity: 1,
            priceInCents: paymentAmountCents
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
    refundedAt: status === "refunded" ? body.refunded_at || null : null,
    customer: {
      name: customer.name || "",
      email: customer.email || "",
      phone: String(customer.phone || ""),
      document: String(customer.document || ""),
      country: "BR",
      ip: "" // Mangofy não envia IP no webhook
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
      utm_campaign: utmsRaw.utm_campaign ? String(utmsRaw.utm_campaign) : undefined,
      utm_content: utmsRaw.utm_content ? String(utmsRaw.utm_content) : undefined,
      utm_term: utmsRaw.utm_term ? String(utmsRaw.utm_term) : undefined
    };

    Object.keys(metadataUtms).forEach((k) => {
      if (metadataUtms[k] === undefined) delete metadataUtms[k];
    });

    const ip =
      req.headers["x-forwarded-for"] ||
      req.socket.remoteAddress ||
      "";

    const userAgent = req.headers["user-agent"] || "";

    const externalCode = `dep_${Date.now()}`;

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
      // 🔥 AGORA usando a URL certa da Railway
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
      metadata: {
        ...metadataUtms,
        ip,
        user_agent: userAgent
      },
      extra: {
        cybersource_fingerprint: "",
        seon_fingerprint: "",
        utms: utmsRaw,
        userAgent,
        browser: "",
        metadata: {
          ...metadataUtms,
          ip,
          user_agent: userAgent
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

    res.status(mgRes.status).json(data);
  } catch (err) {
    console.error("Erro ao gerar pagamento:", err);
    res.status(500).json({ error: "Erro ao gerar pagamento" });
  }
});

/**
 * Webhook da Mangofy
 */
app.post("/api/webhookmangofy", async (req, res) => {
  try {
    const body = req.body;
    console.log("[WEBHOOK MANGOFY RECEBIDO]", JSON.stringify(body, null, 2));

    const utmifyOrder = buildUtmifyOrderFromWebhook(body);

    // dispara pro UTMify sem travar a resposta do webhook
    sendToUtmify(utmifyOrder).catch((err) => {
      console.error("Erro no envio assíncrono para UTMify:", err);
    });

    res.status(200).json({ received: true });
  } catch (err) {
    console.error("Erro no webhook Mangofy:", err);
    res.status(200).json({ received: true, error: true });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
