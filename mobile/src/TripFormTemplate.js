import { organizationKey, splitTripDestination, TRIP_CITIES } from './TripDestinations';
import { tripBudgetDraft } from './TripBudget';

export const MAX_TRIP_ORGANIZATIONS = 30;

export function contractRouteStops(contract, city) {
  const objects = contract?.objects ?? [];
  const hasDuplicateNames = new Set(objects.map(object => object.name.toLowerCase())).size < objects.length;
  return objects.map(object => {
    const name = hasDuplicateNames ? `${object.name} · объект №${object.id}` : object.name;
    return { id: `contract:${contract.id}:${object.id}`, objectId: String(object.id), name,
      destination: city ? `${city} · ${name}` : name };
  });
}

export function tripPlannedBudget(trip) {
  return (trip?.offerId != null || trip?.budget == null ? trip?.estimate : trip.budget) ?? null;
}

export function tripFormTemplate(trip, objects = [], organizationOptions = [], contracts = []) {
  const stops = trip?.stops ?? [];
  const places = stops.map(stop => splitTripDestination(stop.destination));
  const legacyPlace = splitTripDestination(trip?.destination ?? '');
  const firstCity = places[0]?.city;
  const commonCity = firstCity && places.every(place => place.city === firstCity) ? firstCity : '';
  const draft = {
    placeSource: 'organizations',
    cityName: stops.length ? commonCity : legacyPlace.city ?? '',
    objectId: null,
    organizations: [],
    destination: '',
    purpose: trip?.purpose ?? '',
    budgetDraft: tripBudgetDraft(tripPlannedBudget(trip)),
    visitSchedule: [],
    plannedStart: trip?.plannedStart ?? null,
    plannedEnd: trip?.plannedEnd ?? null,
  };

  const contract = contracts.find(item => item.objects.length && String(item.id) === String(trip?.contractId));
  if (contract) {
    const savedNames = new Set(stops.map(stop => stop.destination));
    const routeWithoutCity = contractRouteStops(contract, '');
    const routeWithCity = commonCity ? contractRouteStops(contract, commonCity) : [];
    const cityMatches = routeWithCity.filter(stop => savedNames.has(stop.destination)).length;
    const plainMatches = routeWithoutCity.filter(stop => savedNames.has(stop.destination)).length;
    const useCity = cityMatches > plainMatches;
    const currentStops = new Map((useCity ? routeWithCity : routeWithoutCity).map(stop => [stop.destination, stop.id]));
    const visitSchedule = stops.filter(stop => currentStops.has(stop.destination))
      .map(stop => ({ id: currentStops.get(stop.destination), plannedAt: stop.plannedAt ?? null }));
    return { ...draft, placeSource: 'contract', contractId: String(contract.id), cityName: useCity ? commonCity : '', visitSchedule };
  }

  if (stops.length > MAX_TRIP_ORGANIZATIONS) {
    throw new Error(`В прошлой поездке больше ${MAX_TRIP_ORGANIZATIONS} объектов. Выберите действующий договор с объектами или составьте новый маршрут до ${MAX_TRIP_ORGANIZATIONS} точек.`);
  }

  const directoryObject = trip?.objectId == null ? null
    : objects.find(object => String(object.id) === String(trip.objectId));
  if (directoryObject) {
    const objectId = String(directoryObject.id);
    return { ...draft, placeSource: 'directory', objectId,
      visitSchedule: [{ id: `object:${objectId}`, plannedAt: stops[0]?.plannedAt ?? null }] };
  }

  if (stops.length) {
    const names = stops.map((stop, index) => commonCity ? places[index].name : stop.destination);
    const catalog = new Map(organizationOptions.map(option => [organizationKey(option.label ?? option.id), option.id]));
    const matched = names.map(name => catalog.get(organizationKey(name)) ?? name);
    // Keep distinct recorded stops if normalization maps them to the same catalog entry.
    const organizations = new Set(matched).size === names.length ? matched : names;
    return { ...draft, organizations, visitSchedule: organizations.map((name, index) => ({
      id: `organizations:${name}`, plannedAt: stops[index].plannedAt ?? null,
    })) };
  }

  const city = TRIP_CITIES.find(option => option.id === legacyPlace.name && !legacyPlace.city);
  if (city) return { ...draft, cityName: city.id };
  if (!legacyPlace.name) return draft;
  return { ...draft, placeSource: 'manual', destination: legacyPlace.name,
    visitSchedule: [{ id: `manual:${legacyPlace.name}`, plannedAt: null }] };
}
