import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(cors());
app.use(express.json());

const MANGOFY_URL = "https://checkout.mangofy.com.br/api/v1/payment";

const STORE_CODE_HEADER = process.env.MANGOFY_STORE_CODE_HEADER;
const AUTH_HEADER = process.env.MANGOFY_AUTHORIZATION;
const STORE_CODE_BODY = process.env.MANGOFY_STORE_CODE_BODY;

app.get("/", (req, res) => {
  res.json({ ok: true, msg: "API da Railway está rodando 🚀" });
});

app.post("/api/pix", async (req, res) => {
  try {
    const { valor, nome, email, documento } = req.body;

    const payload = {
      store_code: STORE_CODE_BODY,
      external_code: `dep_${Date.now()}`,
      payment_method: "pix",
      payment_amount: valor,
      pix: { expires_in_days: 1 },
      payment_format: "regular",
      installments: 1,
      postback_url: "https://raspagreen.cloud/api/webhookmangofy",
      items: [
        { code: "DEP", amount: 1, price: valor }
      ],
      customer: {
        email: email || "",
        name: nome || "",
        document: documento || "",
        phone: "",
        ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress
      },
      extra: { cybersource_fingerprint: "", seon_fingerprint: "", utms: "" }
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
    res.status(mgRes.status).json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao gerar pagamento" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
