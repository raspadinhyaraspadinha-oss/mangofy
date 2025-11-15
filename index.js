import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(cors());
app.use(express.json());

/* ============ CONFIGURAÇÕES ============ */
const MANGOFY_URL = "https://checkout.mangofy.com.br/api/v1/payment";
const UTMIFY_URL = "https://api.utmify.com.br/api-credentials/orders";

// VARIÁVEIS NA RAILWAY
const STORE_CODE_HEADER = process.env.MANGOFY_STORE_CODE_HEADER;
const AUTH_HEADER = process.env.MANGOFY_AUTHORIZATION;
const STORE_CODE_BODY = process.env.MANGOFY_STORE_CODE_BODY;
const UTMIFY_API_TOKEN = process.env.UTMIFY_API_TOKEN; // Adicione essa variável na Railway!

// CLIENTE FIXO
const FIXED_CUSTOMER = {
  name: "THIAGO MATIAS SOUZA",
  email: "thiagopagamentoss@gmail.com",
  phone: "31993360332",
  document: "70116952148",
  country: "BR"
};

/* ============ FUNÇÃO: ENVIAR PARA UTMIFY ============ */
async function sendToUtmify({ paymentCode, status, valor, utms, createdAt, approvedAt = null }) {
  const body = {
    orderId: paymentCode,
    platform: "RaspaGreen",
    paymentMethod: "pix",
    status, // "waiting_payment" ou "paid"
    createdAt,
    approvedDate: approvedAt,
    refundedAt: null,
    customer: FIXED_CUSTOMER,
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
    trackingParameters: {
      src: null,
      sck: null,
      utm_source: utms?.utm_source || null,
      utm_campaign: utms?.utm_campaign || null,
      utm_medium: utms?.utm_medium || null,
      utm_content: utms?.utm_content || null,
      utm_term: utms?.utm_term || null
    },
    commission: {
      totalPriceInCents: valor,
      gatewayFeeInCents: Math.round(valor * 0.03), // Exemplo: 3%
      userCommissionInCents: valor - Math.round(valor * 0.03)
    },
    isTest: false
  };

  const res = await fetch(UTMIFY_URL, {
    method: "POST",
    headers: {
      "x-api-token": UTMIFY_API_TOKEN,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const data = await res.json();
  console.log(`[UTMIFY][${status}] →`, data);
}

/* ============ FUNÇÃO: VERIFICAR STATUS DO PIX ============ */
async function monitorPixStatus(paymentCode, valor, utms, createdAt) {
  const headers = {
    "Authorization": AUTH_HEADER,
    "Store-Code": STORE_CODE_HEADER,
    "Content-Type": "application/json",
    "Accept": "application/json"
  };

  let attempts = 0;
  const interval = setInterval(async () => {
    attempts++;
    if (attempts > 7) {
      clearInterval(interval);
      console.log(`[Monitor] Tempo limite atingido para ${paymentCode}`);
      return;
    }

    const res = await fetch(`${MANGOFY_URL}/${paymentCode}`, { headers });
    const data = await res.json();
    console.log(`[Monitor] Check #${attempts} - ${paymentCode}: ${data.payment_status}`);

    if (data.payment_status === "approved") {
      clearInterval(interval);
      const approvedAt = new Date().toISOString().replace("T", " ").substring(0, 19);
      await sendToUtmify({
        paymentCode,
        status: "paid",
        valor,
        utms,
        createdAt,
        approvedAt
      });
    }
  }, 40000); // 40 segundos
}

/* ============ ROTA PRINCIPAL /api/pix ============ */
app.post("/api/pix", async (req, res) => {
  try {
    const valor = req.body.valor;
    const utms = req.body.utms || {};
    if (!valor) return res.status(400).json({ error: "valor é obrigatório" });

    const externalCode = `dep_${Date.now()}`;
    const createdAt = new Date().toISOString().replace("T", " ").substring(0, 19);

    const payload = {
      store_code: STORE_CODE_BODY,
      external_code: externalCode,
      payment_method: "pix",
      payment_amount: valor,
      pix: { expires_in_days: 1 },
      payment_format: "regular",
      installments: 1,
      postback_url: "https://raspagreen.cloud/api/webhookmangofy",
      items: [{ code: `DEP-${externalCode}`, amount: 1, price: valor }],
      customer: { ...FIXED_CUSTOMER, ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress },
      extra: { utms }
    };

    const mgRes = await fetch(MANGOFY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Store-Code": STORE_CODE_HEADER,
        "Authorization": AUTH_HEADER
      },
      body: JSON.stringify(payload)
    });

    const data = await mgRes.json();

    if (!mgRes.ok || !data.payment_code) {
      console.error("Erro Mangofy:", data);
      return res.status(500).json({ error: "Erro ao gerar pagamento", details: data });
    }

    const paymentCode = data.payment_code;

    // Envia o evento "Pix Gerado" pra UTMify
    await sendToUtmify({
      paymentCode,
      status: "waiting_payment",
      valor,
      utms,
      createdAt
    });

    // Inicia monitoramento de aprovação
    monitorPixStatus(paymentCode, valor, utms, createdAt);

    // Retorna pro site o qrcode
    res.json({
      success: true,
      payment_code: paymentCode,
      pix_qr: data.qr_code_image || data.pix?.qr_code_base64,
      data
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro interno ao gerar pagamento" });
  }
});

/* ============ ROTA TESTE ============ */
app.get("/", (req, res) => res.json({ ok: true, msg: "API Railway + UTMify + Mangofy ativa 🚀" }));

/* ============ START SERVER ============ */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
