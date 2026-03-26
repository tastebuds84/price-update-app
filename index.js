require("dotenv").config();

const express = require("express");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-01";

const SOURCE_SHOP = process.env.SOURCE_SHOP;
const SOURCE_WEBHOOK_SECRET = process.env.SOURCE_WEBHOOK_SECRET;

const DEST_SHOP = process.env.DEST_SHOP;
const DEST_ADMIN_TOKEN = process.env.DEST_ADMIN_TOKEN;

// IMPORTANT:
// Shopify webhook HMAC verification must use the raw body.
// So we use express.raw() only on the webhook route.
app.post("/webhook/products-update", express.raw({ type: "*/*" }), async (req, res) => {
  try {
    const hmacHeader = req.get("X-Shopify-Hmac-Sha256");
    const shopDomain = req.get("X-Shopify-Shop-Domain");
    const topic = req.get("X-Shopify-Topic");

    if (!hmacHeader) {
      console.error("Missing HMAC header");
      return res.status(401).send("Missing HMAC");
    }

    if (shopDomain !== SOURCE_SHOP) {
      console.error(`Unexpected shop domain: ${shopDomain}`);
      return res.status(401).send("Invalid shop domain");
    }

    if (topic !== "products/update") {
      console.error(`Unexpected topic: ${topic}`);
      return res.status(400).send("Unexpected webhook topic");
    }

    const rawBody = req.body; // Buffer
    const digest = crypto
      .createHmac("sha256", SOURCE_WEBHOOK_SECRET)
      .update(rawBody, "utf8")
      .digest("base64");

    const valid = crypto.timingSafeEqual(
      Buffer.from(digest, "utf8"),
      Buffer.from(hmacHeader, "utf8")
    );

    if (!valid) {
      console.error("HMAC validation failed");
      return res.status(401).send("Invalid HMAC");
    }

    const product = JSON.parse(rawBody.toString("utf8"));

    console.log(`Webhook received for product: ${product.id} / ${product.title || "Untitled"}`);

    if (!Array.isArray(product.variants) || product.variants.length === 0) {
      console.log("No variants found in webhook payload");
      return res.status(200).send("No variants");
    }

    let updatedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;

    for (const variant of product.variants) {
      const sku = variant.sku ? String(variant.sku).trim() : "";
      const newPrice = variant.price != null ? String(variant.price).trim() : "";

      if (!sku || !newPrice) {
        console.log(`Skipping variant with missing sku/price. SKU="${sku}" PRICE="${newPrice}"`);
        skippedCount++;
        continue;
      }

      try {
        const destVariant = await findDestinationVariantBySku(sku);

        if (!destVariant) {
          console.log(`No destination variant found for SKU: ${sku}`);
          skippedCount++;
          continue;
        }

        const currentDestPrice = String(destVariant.price ?? "").trim();

        if (currentDestPrice === newPrice) {
          console.log(`Price already same for SKU ${sku}. Skipping.`);
          skippedCount++;
          continue;
        }

        await updateDestinationVariantPrice({
          productId: destVariant.product.id,
          variantId: destVariant.id,
          price: newPrice,
        });

        console.log(
          `Updated SKU ${sku}: ${currentDestPrice || "N/A"} -> ${newPrice}`
        );

        updatedCount++;
      } catch (err) {
        console.error(`Error processing SKU ${sku}:`, err.message);
        errorCount++;
      }
    }

    console.log({
      updatedCount,
      skippedCount,
      errorCount,
    });

    return res.status(200).send("Webhook processed");
  } catch (err) {
    console.error("Webhook handler error:", err);
    return res.status(500).send("Server error");
  }
});

app.get("/", (req, res) => {
  res.send("Shopify price sync server is running.");
});

// -----------------------------
// Shopify GraphQL helper
// -----------------------------
async function shopifyGraphQL(shop, token, query, variables = {}) {
  const response = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} from Shopify ${shop}: ${JSON.stringify(data)}`
    );
  }

  if (data.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(data.errors)}`);
  }

  return data.data;
}

// -----------------------------
// Find destination variant by SKU
// -----------------------------
async function findDestinationVariantBySku(sku) {
  const query = `
    query FindVariantBySku($query: String!) {
      productVariants(first: 10, query: $query) {
        edges {
          node {
            id
            sku
            price
            product {
              id
              title
            }
          }
        }
      }
    }
  `;

  const variables = {
    query: `sku:${sku}`,
  };

  const data = await shopifyGraphQL(DEST_SHOP, DEST_ADMIN_TOKEN, query, variables);

  const matches = data.productVariants.edges.map(edge => edge.node);

  // Exact match only, to avoid partial surprises
  const exact = matches.find(v => String(v.sku).trim() === sku);

  if (matches.length > 1) {
    console.warn(`Multiple variants returned for SKU ${sku}. Using exact first match if found.`);
  }

  return exact || null;
}

// -----------------------------
// Update destination variant price
// Shopify recommends GraphQL for new work.
// productVariantsBulkUpdate updates variants for a single product.
// -----------------------------
async function updateDestinationVariantPrice({ productId, variantId, price }) {
  const mutation = `
    mutation UpdateVariantPrice($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        product {
          id
          title
        }
        productVariants {
          id
          price
          sku
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {
    productId,
    variants: [
      {
        id: variantId,
        price,
      },
    ],
  };

  const data = await shopifyGraphQL(DEST_SHOP, DEST_ADMIN_TOKEN, mutation, variables);

  const result = data.productVariantsBulkUpdate;

  if (result.userErrors && result.userErrors.length > 0) {
    throw new Error(`Mutation userErrors: ${JSON.stringify(result.userErrors)}`);
  }

  return result;
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});