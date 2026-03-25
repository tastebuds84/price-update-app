require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');

const app = express();
const port = process.env.PORT || 3000;

app.use(bodyParser.json());



// Webhook endpoint to handle product price updates
app.post('/webhook', async (req, res) => {
  // Log the incoming request payload
  console.log("Webhook Payload:", req.body);

  const product = req.body;
  const variants = product.variants;
  let updated = 0;

  for (let variant of variants) {
    const sku = variant.sku;
    const price = variant.price;

    if (sku && price) {
      try {
        // Check if variant exists in the destination store
        const variantInDest = await findDestVariantBySku(sku);
        
        if (variantInDest) {
          // If variant exists, update the price
          await updatePrice(variantInDest.id, price);
          updated++;
        } else {
          console.log(`Variant with SKU ${sku} not found on destination store.`);
        }
      } catch (error) {
        console.error("Error during price update:", error);
      }
    }
  }

  res.status(200).send(`Successfully processed ${updated} price updates.`);
});

// Function to find variant by SKU in the destination store
async function findDestVariantBySku(sku) {
  const query = `sku:"${sku}"`;

  const data = await shopifyGraphQL(DEST_SHOP, DEST_TOKEN, `
    query FindDestVariantBySku($query: String!) {
      productVariants(first: 5, query: $query) {
        nodes {
          id
          sku
          title
          displayName
          price {
            amount
          }
        }
      }
    }
  `, { query: sku });

  const exactMatches = data.productVariants.nodes.filter((v) => v.sku === sku);

  if (exactMatches.length === 0) return null;
  if (exactMatches.length > 1) {
    throw new Error(`Multiple exact matches in destination for SKU "${sku}"`);
  }

  return exactMatches[0];
}

// Function to update price in destination store
async function updatePrice(variantId, price) {
  const input = {
    price: price,
  };

  const data = await shopifyGraphQL(DEST_SHOP, DEST_TOKEN, `
    mutation UpdateProductPrice($id: ID!, $input: ProductVariantInput!) {
      productVariantUpdate(id: $id, input: $input) {
        productVariant {
          id
          price {
            amount
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `, { id: variantId, input });

  const errors = data.productVariantUpdate.userErrors || [];
  if (errors.length) {
    throw new Error(`updateProductPrice failed: ${errors.map((e) => e.message).join("; ")}`);
  }

  console.log(`Price updated for variant ${variantId} to ${price}`);
}

// Shopify GraphQL call to the destination store
async function shopifyGraphQL(shop, token, query, variables = {}) {
  const url = `https://${shop}/admin/api/2026-01/graphql.json`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
    },
    body: JSON.stringify({ query, variables }),
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON from ${shop}: ${text}`);
  }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${shop}: ${text}`);
  }

  if (json.errors) {
    throw new Error(`GraphQL errors from ${shop}: ${JSON.stringify(json.errors)}`);
  }

  return json.data;
}

// Start the server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

console.log("Destination Shopify Shop:", process.env.DEST_SHOP);
console.log("Destination Shopify Token:", process.env.DEST_TOKEN);
console.log("Webhook Payload:", req.body);