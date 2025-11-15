import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(cors());
app.use(express.json());

/* ============ CONFIG GERAL ============ */

// Criar pagamento
const MANGOFY_CREATE_URL = "https://checkout.mangofy.com.br/api/v1/payment";
// Consultar pagamento por código
const MANGOFY_GET_BASE_URL = "https://checkout.mangofy.com.br/api/v1/payment";

const UTMIFY_URL = "https://api.utmify.com.br/api-credentials/orders";

// ENV (configure na Railway → Variables)
const STORE_CODE_HEADER = process.env.MANGOFY_STORE_CODE_HEADER;
const AUTH_HEADER = process.env.MANGOFY_AUTHORIZATION;
const STORE_CODE_BODY = process.env.MANGOFY_STORE_CODE_BODY;
const UTMIFY_API_TOKEN = process.env.UTMIFY_API_TOKEN; // token da UTMify

// Dados fixos do cliente (como você definiu)
const FIXED_CUSTOMER = {
  name: "THIAGO MATIAS SOUZA",
  email: "thiagopagamentoss@gmail.com",
  phone: "31993360332",
  document: "70116952148",
  country: "BR"
};

/* ============ HELPERS ============ */

// Formata NOW em UTC no padrão 'YYYY-MM-DD HH:MM:SS'
function nowUtcString() {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

// Monta objeto trackingParameters para UTMify
function buildTrackingParameters(utms = {}) {
  return {
    src: utms.src || null,
    sck: utms.sck || null,
    utm_source: utms.utm_source || null,
    utm_campaign: utms.utm_campaign || null,
    utm_medium: utms.utm_medium || null,
    utm_content: utms.utm_content || null,
    utm_term: utms.utm_term || null
  };
}

/* ============ UTMIFY ============ */

async function sendToUtmify({
  paymentCode,
  status,           // "waiting_payment" ou "paid"
  valor,            // em centavos
  utms,
  createdAtUtc,
  approvedAtUtc = null
}) {
  const trackingParameters = buildTrackingParameters(utms);

  // comissão: 3% pro gateway (ajuste se quiser outro valor)
  const gatewayFee = Math.round(valor * 0.03) || 1;
  const userCommission = valor - gatewayFee;

  const body = {
    orderId: paymentCode,
    platform: "RaspaGreen",            // nome da “plataforma” que aparece lá
    paymentMethod: "pix",
    status,                            // waiting_payment | paid
    createdAt: createdAtUtc,           // UTC
    approvedDate: approvedAtUtc,       // UTC ou null
    refundedAt: null,
    customer: {
      name: FIXED_CUSTOMER.name,
      email: FIXED_CUSTOMER.email,
      phone: FIXED_CUSTOMER.phone,
      document: FIXED_CUSTOMER.document,
      country: FIXED_CUSTOMER.country,
      // ip é opcional, podemos não enviar aqui
    },
    products: [
      {
        id: paymentCode,
        name: "Raspadinha Digital",
        planId: null,
        planName: null,
        quantity: 1,
        priceInCents: valor
      }
    ],
    trackingParameters,
    commission: {
      totalPriceInCents: valor,
      gatewayFeeInCents: gatewayFee,
      userCommissionInCents: userCommission
    },
    isTest: false
  };

  try {
    const res = await fetch(UTMIFY_URL, {
      method: "POST",
      headers: {
        "x-api-token": UTMIFY_API_TOKEN,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }

    console.log(`[UTMIFY][${status}] status=${res.status} →`, data);
  } catch (err) {
    console.error(`[UTMIFY][${status}] ERRO:`, err);
  }
}

/* ============ MONITORAR PIX ============ */

async function monitorPixStatus(paymentCode, valor, utms, createdAtUtc) {
  console.log(`[Monitor] Iniciando monitoramento de ${paymentCode}...`);

  let attempts = 0;
  const maxAttempts = 7;         // ~ 7 * 40s ≈ 4m40s
  const intervalMs = 40000;      // 40 segundos

  const headers = {
    "Authorization": AUTH_HEADER,
    "Store-Code": STORE_CODE_HEADER,
    "Content-Type": "application/json",
    "Accept": "application/json"
  };

  const interval = setInterval(async () => {
    attempts++;
    if (attempts > maxAttempts) {
      clearInterval(interval);
      console.log(`[Monitor] Tempo limite atingido para ${paymentCode}`);
      return;
    }

    try {
      const url = `${MANGOFY_GET_BASE_URL}/${paymentCode}`;
      const res = await fetch(url, { method: "GET", headers });
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }

      const status = data.payment_status;
      console.log(`[Monitor] Check #${attempts} - ${paymentCode}:`, status, "HTTP:", res.status);

      if (status === "approved") {
        clearInterval(interval);
        const approvedAtUtc = nowUtcString();
        await sendToUtmify({
          paymentCode,
          status: "paid",
          valor,
          utms,
          createdAtUtc,
          approvedAtUtc
        });
      }
    } catch (err) {
      console.error(`[Monitor] ERRO no check de ${paymentCode}:`, err);
    }
  }, intervalMs);
}

/* ============ ROTA /api/pix ============ */

app.post("/api/pix", async (req, res) => {
  try {
    const valor = req.body.valor;
    const utms = req.body.utms || {};

    if (!valor || typeof valor !== "number") {
      return res.status(400).json({ error: "valor (em centavos) é obrigatório e deve ser number" });
    }

    const externalCode = `dep_${Date.now()}`;
    const createdAtUtc = nowUtcString();

    const payload = {
      store_code: STORE_CODE_BODY,
      external_code: externalCode,
      payment_method: "pix",
      payment_amount: valor,
      pix: { expires_in_days: 1 },
      payment_format: "regular",
      installments: 1,
      postback_url: "https://raspagreen.cloud/api/webhookmangofy",
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
        ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress || "",
      },
      extra: {
        utms   // manda as utms cruas pra Mangofy
      }
    };

    // Cria pagamento na Mangofy
    const mgRes = await fetch(MANGOFY_CREATE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Store-Code": STORE_CODE_HEADER,
        "Authorization": AUTH_HEADER
      },
      body: JSON.stringify(payload)
    });

    const mgText = await mgRes.text();
    let mgData;
    try {
      mgData = JSON.parse(mgText);
    } catch {
      mgData = { raw: mgText };
    }

    if (!mgRes.ok || !mgData.payment_code) {
      console.error("Erro Mangofy:", mgData);
      return res.status(500).json({ error: "Erro ao gerar pagamento", details: mgData });
    }

    const paymentCode = mgData.payment_code;
    console.log("[Mangofy][create] OK:", paymentCode);

    // Envia "Pix Gerado" para UTMify
    await sendToUtmify({
      paymentCode,
      status: "waiting_payment",
      valor,
      utms,
      createdAtUtc
    });

    // Inicia monitoramento assíncrono para saber se foi pago
    monitorPixStatus(paymentCode, valor, utms, createdAtUtc);

    // Resposta para o frontend
    const qrText =
      mgData.data?.pix?.pix_qrcode_text ||
      mgData.pix?.pix_qrcode_text ||
      null;

    res.json({
      success: true,
      payment_code: paymentCode,
      pix_qrcode_text: qrText,
      data: mgData
    });
  } catch (err) {
    console.error("ERRO /api/pix:", err);
    res.status(500).json({ error: "Erro interno ao gerar pagamento" });
  }
});

/* ============ ROTA TESTE ============ */

app.get("/", (req, res) => {
  res.json({ ok: true, msg: "API Railway + Mangofy + UTMify ativa 🚀" });
});

/* ============ START SERVER ============ */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Servidor rodando na porta " + PORT);
});
