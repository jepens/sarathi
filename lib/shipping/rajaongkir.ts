import fetch from 'node-fetch';

const API_KEY = process.env.SHIPPING_COST_KOMERCE_API_KEY;
const BASE_URL = 'https://rajaongkir.komerce.id/api/v1';

export interface ShippingDestination {
    id: number;
    label: string;
    province_id: number;
    province_name: string;
    city_id: number;
    city_name: string;
    district_id: number;
    district_name: string;
    subdistrict_id: number;
    subdistrict_name: string;
    postal_code: string;
}

export interface ShippingCost {
    name: string;
    code: string;
    service: string;
    description: string;
    cost: number;
    etd: string;
}

export interface ShippingCostResponse {
    meta: {
        message: string;
        code: number;
        status: string;
    };
    data: ShippingCost[];
}

interface DestinationResponseItem {
    id: number;
    label: string;
    province_id: number;
    province_name: string;
    city_id: number;
    city_name: string;
    district_id: number;
    district_name: string;
    subdistrict_id: number;
    subdistrict_name: string;
    postal_code: string;
}

interface DestinationSearchResponse {
    meta: {
        status: string;
        message: string;
        code: number;
    };
    data: DestinationResponseItem[];
}

/**
 * Search for shipping destinations by city name
 */
export async function searchDestination(query: string, limit: number = 10): Promise<ShippingDestination[]> {
    if (!API_KEY) {
        console.warn('SHIPPING_COST_KOMERCE_API_KEY is not set');
        return [];
    }

    try {
        const url = `${BASE_URL}/destination/domestic-destination?search=${encodeURIComponent(query)}&limit=${limit}&offset=0`;

        const response = await fetch(url, {
            headers: {
                'key': API_KEY
            }
        });

        if (!response.ok) {
            console.error('Destination search failed:', await response.text());
            return [];
        }

        const result = (await response.json()) as DestinationSearchResponse;

        if (result.meta?.status === 'success' && result.data) {
            return result.data.map((item) => ({
                id: item.id,
                label: item.label,
                province_id: item.province_id,
                province_name: item.province_name,
                city_id: item.city_id,
                city_name: item.city_name,
                district_id: item.district_id,
                district_name: item.district_name,
                subdistrict_id: item.subdistrict_id,
                subdistrict_name: item.subdistrict_name,
                postal_code: item.postal_code
            }));
        }

        return [];
    } catch (error) {
        console.error('Error searching destination:', error);
        return [];
    }
}

/**
 * Calculate shipping cost
 * @param originId - Origin subdistrict ID
 * @param destinationId - Destination subdistrict ID
 * @param weight - Package weight in grams
 * @param courier - Courier code (e.g., 'jne', 'sicepat', 'jnt')
 */
export async function calculateShippingCost(
    originId: number,
    destinationId: number,
    weight: number,
    courier: string = 'jne'
): Promise<ShippingCost[]> {
    if (!API_KEY) {
        console.warn('SHIPPING_COST_KOMERCE_API_KEY is not set');
        return [];
    }

    try {
        const url = `${BASE_URL}/calculate/domestic-cost`;

        // API expects form-urlencoded data
        const params = new URLSearchParams({
            origin: originId.toString(),
            destination: destinationId.toString(),
            weight: weight.toString(),
            courier: courier
        });

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'key': API_KEY,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: params.toString()
        });

        if (!response.ok) {
            console.error('Shipping cost calculation failed:', await response.text());
            return [];
        }

        const result = (await response.json()) as ShippingCostResponse;

        if (result.meta?.status === 'success' && result.data) {
            return result.data;
        }

        return [];
    } catch (error) {
        console.error('Error calculating shipping cost:', error);
        return [];
    }
}

/**
 * Calculate shipping cost for multiple couriers
 */
export async function calculateMultipleCouriers(
    originId: number,
    destinationId: number,
    weight: number,
    couriers: string[] = ['jne', 'sicepat', 'jnt']
): Promise<Record<string, ShippingCost[]>> {
    const results: Record<string, ShippingCost[]> = {};

    for (const courier of couriers) {
        const costs = await calculateShippingCost(originId, destinationId, weight, courier);
        if (costs.length > 0) {
            results[courier] = costs;
        }
    }

    return results;
}
