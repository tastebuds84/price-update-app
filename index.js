require("dotenv").config();

const express = require("express");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 8080;
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-01";

const SOURCE_SHOP = process.env.SOURCE_SHOP;
const SOURCE_CLIENT_ID = process.env.SOURCE_CLIENT_ID;
const SOURCE_CLIENT_SECRET = process.env.SOURCE_CLIENT_SECRET;

const DEST_SHOP = process.env.DEST_SHOP;
const DEST_ADMIN_TOKEN = process.env.DEST_ADMIN_TOKEN;

function safeCompareBase64(a, b) {
  try {
    const bufA = Buffer.from(a || "", "base64");
    const bufB = Buffer.from(b || "", "base64");
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

app.get("/", (req, res) => {
  res.send("Shopify price sync server is running.");
});

app.post("/webhook/products-update", express.raw({ type: "*/*" }), async (req, res) => {
  try {
    const hmacHeader = req.get("X-Shopify-Hmac-Sha256");
    const shopDomain = req.get("X-Shopify-Shop-Domain");
    const topic = req.get("X-Shopify-Topic");

    console.log("Incoming webhook:");
    console.log("Shop domain:", shopDomain);
    console.log("Expected SOURCE_SHOP:", SOURCE_SHOP);
    console.log("Topic:", topic);

    if (shopDomain !== SOURCE_SHOP) {
      console.error(`Unexpected shop domain: ${shopDomain}`);
      return res.status(401).send("Invalid shop domain");
    }

    if (topic !== "products/update") {
      console.error(`Unexpected topic: ${topic}`);
      return res.status(400).send("Unexpected webhook topic");
    }

    const rawBody = req.body;

    const generatedHmac = crypto
      .createHmac("sha256", SOURCE_CLIENT_SECRET)
      .update(rawBody)
      .digest("base64");

    if (!safeCompareBase64(generatedHmac, hmacHeader)) {
      console.error("HMAC validation failed");
      return res.status(401).send("Invalid HMAC");
    }

    const product = JSON.parse(rawBody.toString("utf8"));

    console.log(`Webhook received for product: ${product.id} / ${product.title || "Untitled"}`);

    if (!Array.isArray(product.variants) || product.variants.length === 0) {
      return res.status(200).send("No variants");
    }

    let updatedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;

    for (const variant of product.variants) {
      const sku = variant.sku ? String(variant.sku).trim() : "";
      const newPrice = variant.price != null ? String(variant.price).trim() : "";

      if (!sku || !newPrice) {
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
          console.log(`Price already same for SKU ${sku}, skipping`);
          skippedCount++;
          continue;
        }

        await updateDestinationVariantPrice({
          productId: destVariant.product.id,
          variantId: destVariant.id,
          price: newPrice,
        });

        console.log(`Updated SKU ${sku}: ${currentDestPrice} -> ${newPrice}`);
        updatedCount++;
      } catch (err) {
        console.error(`Error processing SKU ${sku}:`, err.message);
        errorCount++;
      }
    }

    console.log({ updatedCount, skippedCount, errorCount });

    return res.status(200).send("Webhook processed");
  } catch (err) {
    console.error("Webhook handler error:", err);
    return res.status(500).send("Server error");
  }
});

async function listSourceWebhooks() {
  const query = `
    query {
      webhookSubscriptions(first: 50, topics: [PRODUCTS_UPDATE]) {
        edges {
          node {
            id
            topic
            uri
          }
        }
      }
    }
  `;

  const data = await sourceGraphQL(query);
  return data.webhookSubscriptions.edges.map(edge => edge.node);
}

async function deleteSourceWebhook(id) {
  const mutation = `
    mutation DeleteWebhook($id: ID!) {
      webhookSubscriptionDelete(id: $id) {
        deletedWebhookSubscriptionId
        userErrors {
          field
          message
        }
      }
    }
  `;

  const data = await sourceGraphQL(mutation, { id });

  if (data.webhookSubscriptionDelete.userErrors?.length) {
    throw new Error(JSON.stringify(data.webhookSubscriptionDelete.userErrors));
  }

  return data.webhookSubscriptionDelete;
}

async function getSourceAccessToken() {
  const response = await fetch(`https://${SOURCE_SHOP}/admin/oauth/access_token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: SOURCE_CLIENT_ID,
      client_secret: SOURCE_CLIENT_SECRET,
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(`Source token fetch failed: ${response.status} ${JSON.stringify(data)}`);
  }

  return data.access_token;
}

async function sourceGraphQL(query, variables = {}) {
  const token = await getSourceAccessToken();

  const response = await fetch(`https://${SOURCE_SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(`Source GraphQL HTTP ${response.status}: ${JSON.stringify(data)}`);
  }

  if (data.errors) {
    throw new Error(`Source GraphQL errors: ${JSON.stringify(data.errors)}`);
  }

  return data.data;
}

async function registerSourceWebhook(callbackUrl) {
  const mutation = `
    mutation CreateWebhook($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
      webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
        webhookSubscription {
          id
          topic
          uri
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {
    topic: "PRODUCTS_UPDATE",
    webhookSubscription: {
      uri: callbackUrl,
      format: "JSON",
    },
  };

  const data = await sourceGraphQL(mutation, variables);
  const result = data.webhookSubscriptionCreate;

  if (result.userErrors?.length) {
    throw new Error(`Webhook create failed: ${JSON.stringify(result.userErrors)}`);
  }

  return result.webhookSubscription;
}

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
    throw new Error(`HTTP ${response.status}: ${JSON.stringify(data)}`);
  }

  if (data.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(data.errors)}`);
  }

  return data.data;
}

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
  return matches.find(v => String(v.sku).trim() === sku) || null;
}

async function updateDestinationVariantPrice({ productId, variantId, price }) {
  const mutation = `
    mutation UpdateVariantPrice($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
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
    variants: [{ id: variantId, price }],
  };

  const data = await shopifyGraphQL(DEST_SHOP, DEST_ADMIN_TOKEN, mutation, variables);

  if (data.productVariantsBulkUpdate.userErrors?.length) {
    throw new Error(JSON.stringify(data.productVariantsBulkUpdate.userErrors));
  }

  return data.productVariantsBulkUpdate;
}

app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);

  try {
    const callbackUrl = `${process.env.APP_URL}/webhook/products-update`;

    const existing = await listSourceWebhooks();
    console.log("Existing source webhooks:", existing);

    for (const webhook of existing) {
      if (webhook.uri === callbackUrl) {
        await deleteSourceWebhook(webhook.id);
        console.log("Deleted old webhook:", webhook.id);
      }
    }

    const newWebhook = await registerSourceWebhook(callbackUrl);
    console.log("Webhook registered:", newWebhook);
  } catch (err) {
    console.error("Failed to register webhook:", err.message);
  }
});