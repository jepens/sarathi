# RajaOngkir Shipping Cost Integration

## ✅ Status: WORKING

Integrasi API RajaOngkir untuk perhitungan ongkos kirim telah berhasil diimplementasikan.

## 📋 Configuration

### Environment Variables

Add to `.env.local`:
```bash
SHIPPING_COST_KOMERCE_API_KEY=your-api-key-here
```

Get your API key from: [Collaborator Dashboard](https://collaborator.komerce.id) → Integration → Api Key

### API Details

- **Base URL**: `https://rajaongkir.komerce.id/api/v1`
- **Authentication**: Header `key: YOUR_API_KEY`
- **Content-Type**: `application/x-www-form-urlencoded` (for POST requests)

## 🔧 Available Functions

### 1. Search Destination

Search for shipping destinations by city name:

```typescript
import { searchDestination } from '@/lib/shipping/rajaongkir';

const destinations = await searchDestination('jakarta', 10);
// Returns array of ShippingDestination with subdistrict IDs
```

**Response Example**:
```json
[
  {
    "id": 4117,
    "label": "GROGOL, GROGOL PETAMBURAN, JAKARTA BARAT, DKI JAKARTA, 11450",
    "province_id": 6,
    "province_name": "DKI JAKARTA",
    "city_id": 151,
    "city_name": "JAKARTA BARAT",
    "district_id": 2073,
    "district_name": "GROGOL PETAMBURAN",
    "subdistrict_id": 4117,
    "subdistrict_name": "GROGOL",
    "postal_code": "11450"
  }
]
```

### 2. Calculate Shipping Cost

Calculate shipping cost between two locations:

```typescript
import { calculateShippingCost } from '@/lib/shipping/rajaongkir';

const costs = await calculateShippingCost(
    4117,  // origin subdistrict ID
    4108,  // destination subdistrict ID
    1000,  // weight in grams
    'jne'  // courier code
);
```

**Response Example**:
```json
[
  {
    "name": "Jalur Nugraha Ekakurir (JNE)",
    "code": "jne",
    "service": "CTC",
    "description": "JNE City Courier",
    "cost": 10000,
    "etd": "10 day"
  }
]
```

### 3. Calculate Multiple Couriers

Get shipping costs from multiple couriers at once:

```typescript
import { calculateMultipleCouriers } from '@/lib/shipping/rajaongkir';

const allCosts = await calculateMultipleCouriers(
    4117,
    4108,
    1000,
    ['jne', 'sicepat', 'jnt']
);

// Returns: { jne: [...], sicepat: [...], jnt: [...] }
```

## 🎯 Integration with RAG/Chat

The shipping cost calculation can be integrated into the chat flow:

1. **User asks about shipping cost**
2. **AI asks for destination** (city name)
3. **Search destination** using `searchDestination()`
4. **Calculate cost** using `calculateShippingCost()`
5. **Display options** to user

Example flow:
```
User: "Berapa ongkir ke Jakarta?"
AI: "Ke daerah mana di Jakarta? (contoh: Grogol, Kemayoran, dll)"
User: "Grogol"
AI: [searches destination, calculates cost]
    "Ongkir ke Grogol, Jakarta Barat:
     - JNE CTC: Rp 10.000 (10 hari)
     - SICEPAT REG: Rp 9.000 (2-3 hari)
     - J&T REG: Rp 8.000 (3-4 hari)"
```

## 📊 Available Couriers

Common courier codes:
- `jne` - Jalur Nugraha Ekakurir
- `sicepat` - SiCepat Express
- `jnt` - J&T Express
- `tiki` - TIKI
- `pos` - Pos Indonesia
- `anteraja` - AnterAja
- `lion` - Lion Parcel
- `ninja` - Ninja Xpress
- `idexpress` - ID Express
- `rpx` - RPX

## 🧪 Testing

Run the test script:
```bash
npx tsx scripts/test-komerce-api.ts
```

## 📝 Important Notes

1. **Subdistrict IDs**: The API uses subdistrict IDs (not city IDs) for accurate cost calculation
2. **Weight**: Must be in grams (e.g., 1kg = 1000 grams)
3. **Form-Urlencoded**: POST requests must use `application/x-www-form-urlencoded`, not JSON
4. **Rate Limiting**: Be mindful of API rate limits in production

## 🔗 Files

- `lib/shipping/rajaongkir.ts` - Main shipping service
- `scripts/test-komerce-api.ts` - API testing script
- `.env.example` - Environment variable template
- `docs/RAJAONGKIR_INTEGRATION.md` - This file

## 🐛 Troubleshooting

### Error: "Invalid API key"
- Check if `SHIPPING_COST_KOMERCE_API_KEY` is set in `.env.local`
- Verify the API key is correct in Collaborator Dashboard
- Make sure you're using the "Shipping Cost" API key, not "Shipping Delivery"

### Error: "Field validation failed"
- Ensure you're using `application/x-www-form-urlencoded` content type
- Check that origin and destination are valid subdistrict IDs
- Weight must be a positive number in grams

### No results returned
- Check if the destination search query is specific enough
- Try searching with full city name (e.g., "Jakarta Barat" instead of just "Jakarta")
- Verify API key has proper permissions

## 🚀 Next Steps

1. ✅ API Integration - DONE
2. ⏳ Integrate into RAG system
3. ⏳ Add to chat interface
4. ⏳ Create UI for shipping cost display
5. ⏳ Add to order flow
