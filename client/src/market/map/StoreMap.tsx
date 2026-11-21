/**
 * Marketplace M11 — the map itself (Leaflet). Tiles come from this server
 * (`/api/market/map/tiles`), so the provider's key and the shopper's position
 * stay off third parties; without a provider the pins sit on a plain
 * background. Markers are built with DOM calls (textContent, never HTML
 * strings), so a store's name cannot inject markup.
 */
import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { LatLng } from "../market-geo";

export type MapPin = {
  slug: string;
  name: string;
  latitude: number;
  longitude: number;
  logoUrl: string | null;
  rating: number | null;
  ratingCount: number;
  verified: boolean;
  businessType: string | null;
  pickupEnabled: boolean;
};
export type MapConfig = {
  tiles: string | null;
  attribution: string | null;
  maxZoom: number;
  center: { latitude: number; longitude: number; zoom: number };
};
/** Leaflet's own placeholders, spelled as template holes so the route reads as one literal URL. */
const TILE_TEMPLATE = `/api/market/map/tiles/${"{z}"}/${"{x}"}/${"{y}"}`;
export type MapBox = { south: number; west: number; north: number; east: number };

function pinIcon(pin: MapPin, selected: boolean) {
  const element = document.createElement("span");
  element.className = `codiq-map-pin${selected ? " codiq-map-pin--on" : ""}`;
  element.setAttribute("data-testid", "market-map-pin");
  element.setAttribute("data-slug", pin.slug);
  if (pin.logoUrl) {
    const img = document.createElement("img");
    img.src = pin.logoUrl;
    img.alt = "";
    img.loading = "lazy";
    element.append(img);
  } else {
    element.textContent = pin.name.trim().slice(0, 1) || "•";
  }
  return L.divIcon({ html: element, className: "", iconSize: [36, 36], iconAnchor: [18, 36] });
}

function pointIcon(label: string, testId: string) {
  const element = document.createElement("span");
  element.className = "codiq-map-point";
  element.textContent = label;
  element.setAttribute("data-testid", testId);
  return L.divIcon({ html: element, className: "", iconSize: [28, 28], iconAnchor: [14, 28] });
}

type Props = {
  config: MapConfig;
  pins: MapPin[];
  selected?: string | null;
  onSelect?: (pin: MapPin) => void;
  onMove?: (box: MapBox, zoom: number) => void;
  onTap?: (point: LatLng) => void;
  me?: LatLng | null;
  route?: { from: LatLng | null; to: LatLng | null; corridorKm?: number };
  focus?: { point: LatLng; zoom?: number; at: number } | null;
  fitRoute?: number;
  className?: string;
};

export function StoreMap({
  config,
  pins,
  selected,
  onSelect,
  onMove,
  onTap,
  me,
  route,
  focus,
  fitRoute,
  className,
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const pinLayer = useRef<L.LayerGroup | null>(null);
  const routeLayer = useRef<L.LayerGroup | null>(null);
  const meLayer = useRef<L.LayerGroup | null>(null);
  const handlers = useRef({ onSelect, onMove, onTap });
  handlers.current = { onSelect, onMove, onTap };

  useEffect(() => {
    if (!host.current || map.current) return;
    const instance = L.map(host.current, {
      zoomControl: true,
      attributionControl: true,
      maxZoom: config.maxZoom,
    }).setView([config.center.latitude, config.center.longitude], config.center.zoom);
    instance.attributionControl.setPrefix(false);
    if (config.tiles)
      L.tileLayer(TILE_TEMPLATE, {
        maxZoom: config.maxZoom,
        attribution: config.attribution ?? "",
      }).addTo(instance);
    pinLayer.current = L.layerGroup().addTo(instance);
    routeLayer.current = L.layerGroup().addTo(instance);
    meLayer.current = L.layerGroup().addTo(instance);
    const report = () => {
      const bounds = instance.getBounds();
      handlers.current.onMove?.(
        {
          south: bounds.getSouth(),
          west: bounds.getWest(),
          north: bounds.getNorth(),
          east: bounds.getEast(),
        },
        instance.getZoom()
      );
    };
    instance.on("moveend", report);
    instance.on("click", (event: L.LeafletMouseEvent) =>
      handlers.current.onTap?.({ lat: event.latlng.lat, lng: event.latlng.lng })
    );
    map.current = instance;
    report();
    // Hidden (the list view) and shown again, or the phone turned: Leaflet must re-measure, or pins sit in the wrong place.
    const resize = new ResizeObserver(() => instance.invalidateSize());
    resize.observe(host.current);
    return () => {
      resize.disconnect();
      instance.remove();
      map.current = null;
    };
  }, [config]);

  useEffect(() => {
    const layer = pinLayer.current;
    if (!layer) return;
    layer.clearLayers();
    for (const pin of pins) {
      L.marker([pin.latitude, pin.longitude], {
        icon: pinIcon(pin, pin.slug === selected),
        title: pin.name,
        keyboard: true,
        zIndexOffset: pin.slug === selected ? 1000 : 0,
      })
        .on("click", () => handlers.current.onSelect?.(pin))
        .addTo(layer);
    }
  }, [pins, selected]);

  useEffect(() => {
    const layer = meLayer.current;
    if (!layer) return;
    layer.clearLayers();
    if (me)
      L.circleMarker([me.lat, me.lng], {
        radius: 8,
        weight: 3,
        fillOpacity: 1,
        className: "codiq-map-me",
      }).addTo(layer);
  }, [me]);

  useEffect(() => {
    const layer = routeLayer.current;
    if (!layer) return;
    layer.clearLayers();
    if (route?.from)
      L.marker([route.from.lat, route.from.lng], {
        icon: pointIcon("أ", "market-route-from-pin"),
        interactive: false,
      }).addTo(layer);
    if (route?.to)
      L.marker([route.to.lat, route.to.lng], {
        icon: pointIcon("ب", "market-route-to-pin"),
        interactive: false,
      }).addTo(layer);
    if (route?.from && route.to)
      L.polyline(
        [
          [route.from.lat, route.from.lng],
          [route.to.lat, route.to.lng],
        ],
        { weight: 4, dashArray: "8 8", className: "codiq-map-route" }
      ).addTo(layer);
  }, [route?.from, route?.to]);

  useEffect(() => {
    if (focus && map.current)
      map.current.setView(
        [focus.point.lat, focus.point.lng],
        focus.zoom ?? Math.max(map.current.getZoom(), 14)
      );
  }, [focus]);

  useEffect(() => {
    if (!fitRoute || !map.current || !route?.from || !route.to) return;
    map.current.fitBounds(
      L.latLngBounds([
        [route.from.lat, route.from.lng],
        [route.to.lat, route.to.lng],
      ]).pad(0.25)
    );
  }, [fitRoute]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      ref={host}
      className={
        className ??
        "h-[60vh] min-h-[320px] w-full overflow-hidden rounded-[24px] bg-[var(--codiq-surface-sunken)]"
      }
      data-testid="market-map"
    />
  );
}
