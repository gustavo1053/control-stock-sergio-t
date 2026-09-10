const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const Anthropic = require("@anthropic-ai/sdk");

admin.initializeApp();
const db = admin.firestore();
const COLLECTION = "stock_ac";

const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");
const MODEL = "claude-sonnet-5";
const MAX_TOOL_TURNS = 6;

const SYSTEM_PROMPT = `Sos el asistente interno de "Control de Stock — Sergio T Refrigeración", una planilla de stock de equipos de aire acondicionado.
Respondé siempre en español rioplatense, de forma breve y directa, como si le hablaras a alguien del taller.
Usá las herramientas disponibles para consultar o modificar el stock real: nunca inventes números de stock, precios ni códigos.
Si un pedido es ambiguo (por ejemplo no queda claro el código exacto), preguntá antes de modificar algo.
Antes de registrar una salida, si no tenés la certeza de que hay stock suficiente, consultá el producto primero.
Cuando dupliques o inventes datos podés perjudicar el negocio real, así que siempre basate en el resultado de las herramientas.`;

const TOOLS = [
  {
    name: "consultar_stock",
    description:
      "Busca productos en el stock. Sin filtros devuelve un resumen de todos los productos (hasta 30). Usalo para responder preguntas sobre qué hay o cuánto stock queda.",
    input_schema: {
      type: "object",
      properties: {
        texto: {
          type: "string",
          description: "Texto libre para buscar por código, marca o modelo (coincidencia parcial)."
        },
        tecnologia: {
          type: "string",
          enum: ["Inverter", "On Off"],
          description: "Filtrar por tecnología."
        }
      }
    }
  },
  {
    name: "resumen_stock",
    description:
      "Devuelve totales generales del stock: unidades totales y valor total en pesos.",
    input_schema: { type: "object", properties: {} }
  },
  {
    name: "registrar_movimiento",
    description:
      "Registra una entrada o salida de stock para un producto existente, identificado por su código. Suma la cantidad indicada al acumulado de entradas o salidas.",
    input_schema: {
      type: "object",
      properties: {
        codigo: { type: "string", description: "Código exacto del producto." },
        tipo: { type: "string", enum: ["entrada", "salida"] },
        cantidad: { type: "number", description: "Cantidad de unidades, mayor a 0." }
      },
      required: ["codigo", "tipo", "cantidad"]
    }
  },
  {
    name: "crear_producto",
    description: "Da de alta un producto nuevo en el stock. El código no puede repetirse.",
    input_schema: {
      type: "object",
      properties: {
        codigo: { type: "string" },
        marca: { type: "string" },
        modelo: { type: "string" },
        tipo: { type: "string", description: "Ej: Split, Portátil, Cassette." },
        tecnologia: { type: "string", enum: ["Inverter", "On Off"] },
        btu: { type: "number" },
        minimo: { type: "number", description: "Stock mínimo sugerido." },
        precio: { type: "number", description: "Precio unitario." },
        entradas: { type: "number" },
        salidas: { type: "number" }
      },
      required: ["codigo"]
    }
  }
];

function enrich(p) {
  const entradas = Number(p.entradas) || 0;
  const salidas = Number(p.salidas) || 0;
  const stock = entradas - salidas;
  const precio = Number(p.precio) || 0;
  const tecnologia =
    p.tecnologia ||
    (((p.tipo || "") + " " + (p.modelo || "")).toLowerCase().includes("inverter") ? "Inverter" : "On Off");
  return {
    ...p,
    stock,
    valor: stock * precio,
    tecnologia
  };
}

async function ejecutarHerramienta(name, input) {
  switch (name) {
    case "consultar_stock": {
      const snapshot = await db.collection(COLLECTION).orderBy("codigo").get();
      let productos = snapshot.docs.map((d) => enrich({ id: d.id, ...d.data() }));

      if (input.texto) {
        const t = String(input.texto).toLowerCase();
        productos = productos.filter(
          (p) =>
            (p.codigo || "").toLowerCase().includes(t) ||
            (p.marca || "").toLowerCase().includes(t) ||
            (p.modelo || "").toLowerCase().includes(t)
        );
      }
      if (input.tecnologia) productos = productos.filter((p) => p.tecnologia === input.tecnologia);

      return {
        total_encontrados: productos.length,
        productos: productos.slice(0, 30).map((p) => ({
          codigo: p.codigo,
          marca: p.marca,
          modelo: p.modelo,
          tecnologia: p.tecnologia,
          stock: p.stock,
          precio: p.precio
        }))
      };
    }

    case "resumen_stock": {
      const snapshot = await db.collection(COLLECTION).get();
      const productos = snapshot.docs.map((d) => enrich({ id: d.id, ...d.data() }));
      return {
        cantidad_productos: productos.length,
        total_unidades: productos.reduce((acc, p) => acc + p.stock, 0),
        valor_total: productos.reduce((acc, p) => acc + p.valor, 0)
      };
    }

    case "registrar_movimiento": {
      const codigo = String(input.codigo || "").trim().toUpperCase();
      const tipo = input.tipo;
      const cantidad = Number(input.cantidad);
      if (!codigo || !["entrada", "salida"].includes(tipo) || !(cantidad > 0)) {
        throw new Error("Datos inválidos: se necesita código, tipo ('entrada' o 'salida') y cantidad mayor a 0.");
      }

      const snapshot = await db.collection(COLLECTION).where("codigo", "==", codigo).limit(1).get();
      if (snapshot.empty) {
        throw new Error(`No existe ningún producto con código ${codigo}.`);
      }
      const doc = snapshot.docs[0];
      const campo = tipo === "entrada" ? "entradas" : "salidas";
      const actual = Number(doc.data()[campo]) || 0;
      const nuevoValor = actual + cantidad;

      await doc.ref.update({
        [campo]: nuevoValor,
        actualizado: admin.firestore.FieldValue.serverTimestamp()
      });

      const actualizado = enrich({ id: doc.id, ...doc.data(), [campo]: nuevoValor });
      return {
        ok: true,
        producto: { codigo: actualizado.codigo, stock: actualizado.stock }
      };
    }

    case "crear_producto": {
      const codigo = String(input.codigo || "").trim().toUpperCase();
      if (!codigo) throw new Error("El producto necesita un código.");

      const dupe = await db.collection(COLLECTION).where("codigo", "==", codigo).limit(1).get();
      if (!dupe.empty) throw new Error(`Ya existe un producto con código ${codigo}.`);

      const data = {
        codigo,
        marca: input.marca || "",
        modelo: input.modelo || "",
        tipo: input.tipo || "Split",
        tecnologia: input.tecnologia === "On Off" ? "On Off" : "Inverter",
        btu: Number(input.btu) || 0,
        minimo: Number(input.minimo) || 0,
        precio: Number(input.precio) || 0,
        entradas: Number(input.entradas) || 0,
        salidas: Number(input.salidas) || 0,
        creado: admin.firestore.FieldValue.serverTimestamp(),
        actualizado: admin.firestore.FieldValue.serverTimestamp()
      };
      await db.collection(COLLECTION).add(data);
      return { ok: true, codigo };
    }

    default:
      throw new Error(`Herramienta desconocida: ${name}`);
  }
}

exports.asistenteStock = onRequest({ secrets: [ANTHROPIC_API_KEY], cors: true }, async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Método no permitido, usá POST." });
    return;
  }

  const { mensaje, historial } = req.body || {};
  if (!mensaje || typeof mensaje !== "string") {
    res.status(400).json({ error: "Falta el campo 'mensaje'." });
    return;
  }

  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });
  const messages = Array.isArray(historial) ? historial.slice(-20) : [];
  messages.push({ role: "user", content: mensaje });

  try {
    let respuestaFinal = "";

    for (let turno = 0; turno < MAX_TOOL_TURNS; turno++) {
      const response = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages
      });

      messages.push({ role: "assistant", content: response.content });

      const toolUses = response.content.filter((b) => b.type === "tool_use");
      if (toolUses.length === 0) {
        respuestaFinal = response.content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("\n");
        break;
      }

      const toolResults = [];
      for (const toolUse of toolUses) {
        let resultado;
        try {
          resultado = await ejecutarHerramienta(toolUse.name, toolUse.input || {});
        } catch (err) {
          resultado = { error: err.message };
        }
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: JSON.stringify(resultado)
        });
      }
      messages.push({ role: "user", content: toolResults });
    }

    res.json({
      respuesta: respuestaFinal || "No pude terminar de procesar el pedido, probá de nuevo.",
      historial: messages
    });
  } catch (err) {
    logger.error("Error en asistenteStock", err);
    res.status(500).json({ error: "Hubo un problema con el asistente. Probá de nuevo en un momento." });
  }
});
