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

app.post("/api/pix", async (req, res) => {
  try {
    // o site manda pelo menos isso:
    // { "valor": 3000, "utms": { ... } }
    const valor =
      req.body.payment_amount ||
      req.body.valor ||
      req.body.amount;

    if (!valor) {
      return res
        .status(400)
        .json({ error: "valor (em centavos) é obrigatório" });
    }

    // pode vir um objeto utms ou uma string
    const utmsRaw = req.body.utms || {};

    // garante que tudo vira string (a API costuma gostar disso)
    const metadataUtms = {
      utm_source: utmsRaw.utm_source ? String(utmsRaw.utm_source) : undefined,
      utm_medium: utmsRaw.utm_medium ? String(utmsRaw.utm_medium) : undefined,
      utm_campaign: utmsRaw.utm_campaign ? String(utmsRaw.utm_campaign) : undefined,
      utm_content: utmsRaw.utm_content ? String(utmsRaw.utm_content) : undefined,
      utm_term: utmsRaw.utm_term ? String(utmsRaw.utm_term) : undefined
    };

    // remove as chaves undefined
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
        ip
      },

      // 👉 metadata no topo (algumas plataformas já leem direto daqui)
      metadata: {
        ...metadataUtms,
        ip,
        user_agent: userAgent
      },

      // 👉 extra.metadata: é onde a doc da Mangofy mostra o metadata
      extra: {
        cybersource_fingerprint: "",
        seon_fingerprint: "",
        // mantemos utms cru, se você quiser usar pra debug depois
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

    // log opcional pra depurar o que está indo pra Mangofy
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
