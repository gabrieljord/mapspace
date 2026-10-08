import Point from 'ol/geom/Point';
import CircleStyle from 'ol/style/Circle';
import Fill from 'ol/style/Fill';
import Map from './node_modules/ol/Map';
import View from './node_modules/ol/View';
import TileLayer from './node_modules/ol/layer/Tile';
import XYZ from './node_modules/ol/source/XYZ';
import Feature from 'ol/Feature';
import LineString from 'ol/geom/LineString';
import Polygon from 'ol/geom/Polygon';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import Stroke from 'ol/style/Stroke';
import Style from 'ol/style/Style';
import { fromLonLat } from 'ol/proj';
import GeoJSON from 'ol/format/GeoJSON.js';

// Default and selected styles
const defaultStyle = new Style({
  stroke: new Stroke({ color: 'blue', width: 2 }),
  image: new CircleStyle({
    radius: 6,
    fill: new Fill({ color: 'blue' }),
    stroke: new Stroke({ color: 'white', width: 2 }),
  }),
});

const selectedStyle = new Style({
  stroke: new Stroke({ color: 'yellow', width: 2 }),
  image: new CircleStyle({
    radius: 8,
    fill: new Fill({ color: 'yellow' }),
    stroke: new Stroke({ color: 'black', width: 2 }),
  }),
});

// Configure canvas for frequent pixel reads
const map = new Map({
  target: 'app',
  pixelRatio: 1,
  layers: [
    new TileLayer({
      source: new XYZ({
        url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
      })
    })
  ],
  view: new View({
    center: fromLonLat([-111.8315, 33.4152]), // [lon, lat]
    zoom: 12
  })
});

const current_view = map.getView();

current_view.on('change:resolution', function () {
  const zooms = current_view.getZoom();
  // console.log('Zoom level changed to:', zooms);
  // handleZoomChange(currentZoom); 
});


// Vector layer and source (start empty — trails are added when created)
const vectorSource = new VectorSource();
const vectorLayer = new VectorLayer({ source: vectorSource });
map.addLayer(vectorLayer);

// Global state
let selectedFeature = null;
let vertexLayer = null;
let isCreatingTrail = false;
let originalCoords = null;
const trailFeatures = [];
let globalSelectedIndex = -1; // global index across all trail features
let vertexMap = []; // array of { feature, index, coord }
let isBranching = false; // Track if we're adding points to a branch feature
// If true, the map will smoothly center on the selected vertex. Default false to avoid panning on clicks.
let autoPanOnSelect = false;

// Returns pixel distance from point p to segment a-b
function pointToSegmentPixelDist(p, a, b) {
  const ab = [b[0] - a[0], b[1] - a[1]];
  const len2 = ab[0] * ab[0] + ab[1] * ab[1];
  if (len2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / len2));
  return Math.hypot(p[0] - (a[0] + t * ab[0]), p[1] - (a[1] + t * ab[1]));
}

// Returns the index at which to splice a new coord into a linestring (closest segment)
function findInsertIndex(coords, clickCoord) {
  const clickPixel = map.getPixelFromCoordinate(clickCoord);
  let minDist = Infinity;
  let insertIdx = coords.length;
  for (let i = 0; i < coords.length - 1; i++) {
    const d = pointToSegmentPixelDist(
      clickPixel,
      map.getPixelFromCoordinate(coords[i]),
      map.getPixelFromCoordinate(coords[i + 1])
    );
    if (d < minDist) { minDist = d; insertIdx = i + 1; }
  }
  return insertIdx;
}

// Helper function to check if a coordinate is near an existing vertex
function isNearVertex(coord, threshold = 10) {
  const pixel = map.getPixelFromCoordinate(coord);
  for (let entry of vertexMap) {
    const vertexPixel = map.getPixelFromCoordinate(entry.coord);
    const distance = Math.sqrt(
      Math.pow(pixel[0] - vertexPixel[0], 2) + Math.pow(pixel[1] - vertexPixel[1], 2)
    );
    if (distance <= threshold) {
      return entry;
    }
  }
  return null;
}

// Helper function to check if coordinate is near the first vertex of current trail
function isNearFirstVertex(coord, threshold = 10) {
  if (!selectedFeature || !isCreatingTrail) return false;
  const geometry = selectedFeature.getGeometry();
  if (!geometry || geometry.getType() !== 'LineString') return false;
  
  const coords = geometry.getCoordinates();
  if (coords.length < 3) return false; // Need at least 3 points to close a polygon
  
  const firstCoord = coords[0];
  const pixel = map.getPixelFromCoordinate(coord);
  const firstPixel = map.getPixelFromCoordinate(firstCoord);
  const distance = Math.sqrt(
    Math.pow(pixel[0] - firstPixel[0], 2) + Math.pow(pixel[1] - firstPixel[1], 2)
  );
  return distance <= threshold;
}

const contextMenu = document.getElementById('context-menu');
const contextMenuTrail = document.getElementById('context-menu-trail');

const textarea = document.getElementById('geojson');
const format = new GeoJSON();

function updateTextarea() {
  const features = vectorSource.getFeatures();
  const geojson = format.writeFeatures(features, {
    featureProjection: map.getView().getProjection(),
    dataProjection: 'EPSG:4326'
  });
  textarea.value = geojson;
}

function applyGeomStyle(feature) {
  const type = feature.getGeometry().getType();
  if (type === 'Polygon') {
    feature.setStyle(new Style({
      stroke: new Stroke({ color: 'green', width: 2 }),
      fill: new Fill({ color: 'rgba(0, 255, 0, 0.1)' }),
    }));
  } else {
    feature.setStyle(defaultStyle);
  }
}

textarea.addEventListener('input', function () {
  const text = textarea.value.trim();
  if (!text) return;

  let parsed;
  try {
    parsed = format.readFeatures(text, {
      featureProjection: map.getView().getProjection(),
      dataProjection: 'EPSG:4326',
    });
  } catch (e) {
    return; // invalid / incomplete JSON while typing — ignore
  }
  if (!parsed || parsed.length === 0) return;

  // Exit trail mode if active
  isCreatingTrail = false;
  document.body.style.cursor = 'auto';
  selectedFeature = null;
  globalSelectedIndex = -1;
  trailFeatures.length = 0;
  isBranching = false;
  if (vertexLayer) { map.removeLayer(vertexLayer); vertexLayer = null; }

  vectorSource.clear();
  parsed.forEach(f => {
    applyGeomStyle(f);
    vectorSource.addFeature(f);
  });
});

document.getElementById('clear-map').addEventListener('click', function () {
  isCreatingTrail = false;
  document.body.style.cursor = 'auto';
  selectedFeature = null;
  globalSelectedIndex = -1;
  trailFeatures.length = 0;
  isBranching = false;
  if (vertexLayer) { map.removeLayer(vertexLayer); vertexLayer = null; }
  vectorSource.clear();
  textarea.value = '';
});

document.getElementById('format-json').addEventListener('click', function () {
  const text = textarea.value.trim();
  if (!text) return;
  try {
    textarea.value = JSON.stringify(JSON.parse(text), null, 2);
  } catch (e) { /* invalid JSON, leave as-is */ }
});

// CLICK TO SELECT/DESELECT
map.on('singleclick', function (evt) {
  if (isCreatingTrail) return;
  const clickedFeature = map.forEachFeatureAtPixel(evt.pixel, f => f.get('gIndex') !== undefined ? null : f);

  if (clickedFeature && (clickedFeature.getGeometry().getType() === 'LineString' || clickedFeature.getGeometry().getType() === 'Polygon' || clickedFeature.getGeometry().getType() === 'Point')) {
    // Make sure only this feature is highlighted; set all other features to default
    vectorSource.getFeatures().forEach(f => {
      if (f === clickedFeature) {
        f.setStyle(selectedStyle);
      } else {
        f.setStyle(defaultStyle);
      }
    });

    // Select this feature and make it the single editable trail
    selectedFeature = clickedFeature;
    // Do NOT show vertices on plain click. Vertices will be shown when the user chooses
    // 'Create trail' from the context menu. Keep trailFeatures untouched here.
  } else if (selectedFeature) {
    // Clicked empty space while a feature was selected — deselect
    selectedFeature.setStyle(defaultStyle);
    selectedFeature = null;
    trailFeatures.length = 0;
    contextMenu.style.display = 'none';
    if (vertexLayer) {
      map.removeLayer(vertexLayer);
      vertexLayer = null;
    }
  }
});



// Function to update all vertices
function updateVertices() {
  // Render vertices for all trail features (so branches and parent are visible)
  if (!vertexLayer) {
    vertexLayer = new VectorLayer({ source: new VectorSource() });
    map.addLayer(vertexLayer);
  }

  const src = vertexLayer.getSource();
  src.clear();

  // Rebuild the vertex map from trailFeatures to maintain a global ordering
  vertexMap = [];
  trailFeatures.forEach(feat => {
    const geometry = feat.getGeometry();
    if (!geometry) return;
    
    let coords = [];
    if (geometry.getType() === 'LineString') {
      coords = geometry.getCoordinates();
    } else if (geometry.getType() === 'Polygon') {
      // For polygons, get the outer ring coordinates
      coords = geometry.getCoordinates()[0] || [];
    } else if (geometry.getType() === 'Point') {
      // For points, create a single coordinate entry
      coords = [geometry.getCoordinates()];
    } else {
      return; // Skip other geometry types
    }
    
    coords.forEach((coord, idx) => {
      vertexMap.push({ feature: feat, index: idx, coord });
    });
  });

  // Add a point feature for each vertex in the map
  vertexMap.forEach((entry, gIndex) => {
    if (!entry.coord || !Array.isArray(entry.coord)) return;
    const isSelected = gIndex === globalSelectedIndex;
    const vertex = new Feature(new Point(entry.coord));
    vertex.setStyle(new Style({
      image: new CircleStyle({
        radius: isSelected ? 8 : 6,
        fill: new Fill({ color: isSelected ? 'yellow' : 'red' }),
        stroke: new Stroke({ color: isSelected ? 'black' : 'white', width: 2 }),
      }),
    }));
    // store metadata so we can identify clicks on vertex features if needed
    vertex.set('gIndex', gIndex);
    src.addFeature(vertex);
  });
}

function setGlobalSelected(gIndex) {
  if (gIndex < 0 || gIndex >= vertexMap.length) return;
  globalSelectedIndex = gIndex;
  const entry = vertexMap[gIndex];
  selectedFeature = entry.feature;
  updateVertices();

  // center the view on selection
  if (autoPanOnSelect) {
    map.getView().animate({ center: entry.coord, duration: 200 });
  }
}

// Create a new branch feature starting at a given vertex (does NOT remove or change the parent).
function createBranchFromVertex(parentEntry) {
  if (!parentEntry) return;
  const start = parentEntry.coord;
  const branchFeature = new Feature(new LineString([start]));
  branchFeature.setId(`trail-${Date.now()}`);
  branchFeature.setStyle(selectedStyle);

  // Add branch to source and make it the only editable trail
  vectorSource.addFeature(branchFeature);
  trailFeatures.length = 0;
  trailFeatures.push(branchFeature);

  selectedFeature = branchFeature;
  isBranching = true;

  updateVertices();
  // select the branch start vertex
  const idx = vertexMap.findIndex(e => e.feature === branchFeature && e.index === 0);
  if (idx !== -1) setGlobalSelected(idx);
}

// ADD TRAIL POINTS (handles appending, inserting and branching while keeping all trail features editable)
map.on('click', function (evt) {
  // Only handle clicks while in trail creation mode
  if (!isCreatingTrail) return;

  const featureAtPixel = map.forEachFeatureAtPixel(evt.pixel, f => f);
  // Handle first click for a newly created empty trail feature
  const clickedOnVertex = featureAtPixel && featureAtPixel.get('gIndex') !== undefined;

  // Check if clicking near the first vertex to close polygon
  if (isNearFirstVertex(evt.coordinate)) {
    const geometry = selectedFeature.getGeometry();
    const coords = geometry.getCoordinates();
    // Close the polygon by converting LineString to Polygon
    if (coords.length > 0) {
      coords.push([...coords[0]]); // explicitly close the ring
    }
    const polygonCoords = [coords];
    const polygon = new Polygon(polygonCoords);
    selectedFeature.setGeometry(polygon);
    selectedFeature.setStyle(new Style({
      stroke: new Stroke({
        color: 'green',
        width: 2,
      }),
      fill: new Fill({
        color: 'rgba(0, 255, 0, 0.1)',
      }),
    }));
    
    updateVertices();
    // After closing into a polygon, select the newly added closing vertex
    setGlobalSelected(vertexMap.findIndex(e => e.feature === selectedFeature && e.index === polygonCoords[0].length - 1));
    updateTextarea();
    return;
  }

  // If the user clicked directly on a rendered vertex marker, do nothing here.
  // We don't want clicks on vertex graphics to move existing vertices —
  // extension should happen by clicking the map empty area after highlighting a vertex.
  if (clickedOnVertex) return;

  // Handle first click for a newly created empty trail feature
  if (selectedFeature && selectedFeature.get('isFirstPoint')) {
    const geometry = selectedFeature.getGeometry();
    geometry.setCoordinates([evt.coordinate]);
    selectedFeature.unset('isFirstPoint');
    if (!trailFeatures.includes(selectedFeature)) trailFeatures.push(selectedFeature);
    updateVertices();
    setGlobalSelected(vertexMap.length - 1);
    return;
  }

  // Check if clicking near an existing vertex to connect to it
  const nearVertex = isNearVertex(evt.coordinate);
  if (nearVertex) {
    // Connect to the existing vertex
    const geometry = selectedFeature.getGeometry();
    const coords = geometry.getCoordinates();
    coords.push(nearVertex.coord);
    geometry.setCoordinates(coords);
    updateVertices();
    setGlobalSelected(vertexMap.findIndex(e => e.feature === selectedFeature && e.index === coords.length - 1));
    return;
  }
  if (globalSelectedIndex !== -1) {
    const clickedOnVertex = featureAtPixel && featureAtPixel.get('gIndex') !== undefined;
    const clickedOnLine = featureAtPixel && featureAtPixel.getGeometry && featureAtPixel.getGeometry().getType() === 'LineString';

    // Insert a vertex at the clicked position on a linestring
    if (clickedOnLine && !clickedOnVertex) {
      const lineGeom = featureAtPixel.getGeometry();
      const coords = lineGeom.getCoordinates();
      const insertIdx = findInsertIndex(coords, evt.coordinate);
      const newCoords = [...coords];
      newCoords.splice(insertIdx, 0, evt.coordinate);
      lineGeom.setCoordinates(newCoords);
      selectedFeature = featureAtPixel;
      if (!trailFeatures.includes(featureAtPixel)) {
        trailFeatures.length = 0;
        trailFeatures.push(featureAtPixel);
      }
      updateVertices();
      setGlobalSelected(vertexMap.findIndex(e => e.feature === featureAtPixel && e.index === insertIdx));
      return;
    }

    if (!clickedOnVertex) {
      const parentEntry = vertexMap[globalSelectedIndex];
      const parentFeature = parentEntry.feature;
      const parentGeom = parentFeature.getGeometry();

      // Convert Point to LineString when the user adds a second vertex
      if (parentGeom.getType() === 'Point') {
        const pointCoord = parentGeom.getCoordinates();
        parentFeature.setGeometry(new LineString([pointCoord, evt.coordinate]));
        selectedFeature = parentFeature;
        trailFeatures.length = 0;
        trailFeatures.push(parentFeature);
        updateVertices();
        setGlobalSelected(vertexMap.findIndex(e => e.feature === parentFeature && e.index === 1));
        return;
      }

      const parentIdx = parentEntry.index;
      const parentCoords = parentGeom.getCoordinates();

      // If selected vertex is not the last vertex, start an in-place branch edit
      // by inserting the clicked point into the parent LineString after selected vertex
      // but first store the original coordinates so the user can 'Replace trail' later
      if (parentIdx < parentCoords.length - 1) {
        // When branching from an earlier vertex, append the branch to the END of the same LineString
        // by duplicating the branch start vertex at the end and then adding the new point. This preserves
        // the original sequence of the parent and avoids moving existing segments.
        if (!parentFeature.get('originalCoords')) {
          parentFeature.set('originalCoords', parentCoords.slice());
        }

        const originalLength = parentCoords.length;
        const newCoords = parentCoords.slice();
        // duplicate the start vertex so the branch is attached at the end
        newCoords.push(parentEntry.coord);
        // add the new clicked coordinate (branch endpoint)
        newCoords.push(evt.coordinate);
        parentGeom.setCoordinates(newCoords);

        // record where the branch starts so Replace trail can split it out later
        parentFeature.set('branchStart', originalLength);

        // Keep editing the same parent feature (branch is part of it until Replace trail)
        selectedFeature = parentFeature;
        trailFeatures.length = 0;
        trailFeatures.push(parentFeature);

        // Update vertex rendering and select the newly inserted branch endpoint
        updateVertices();
        setGlobalSelected(vertexMap.findIndex(e => e.feature === parentFeature && e.index === newCoords.length - 1));

        isBranching = true;
        return;
      }

      // Otherwise append to the end of the parent LineString
      const newParentCoords = parentCoords.slice();
      newParentCoords.push(evt.coordinate);
      parentGeom.setCoordinates(newParentCoords);

      selectedFeature = parentFeature;
      if (!trailFeatures.includes(parentFeature)) {
        trailFeatures.length = 0;
        trailFeatures.push(parentFeature);
      }

      updateVertices();
      setGlobalSelected(vertexMap.findIndex(e => e.feature === parentFeature && e.index === newParentCoords.length - 1));
      return;
    }
  }

  // Normal trail creation / appending behavior: append or insert into the currently selected feature
  if (!selectedFeature) return;
  const geometry = selectedFeature.getGeometry();
  if (!geometry) return;

  // Convert Point to LineString when the user adds a second vertex
  if (geometry.getType() === 'Point') {
    const pointCoord = geometry.getCoordinates();
    selectedFeature.setGeometry(new LineString([pointCoord, evt.coordinate]));
    if (!trailFeatures.includes(selectedFeature)) {
      trailFeatures.length = 0;
      trailFeatures.push(selectedFeature);
    }
    updateVertices();
    setGlobalSelected(vertexMap.findIndex(e => e.feature === selectedFeature && e.index === 1));
    return;
  }

  if (geometry.getType() !== 'LineString') return;

  const coords = geometry.getCoordinates();

  // If currently editing a branch, append to its end
  if (isBranching && trailFeatures.includes(selectedFeature)) {
    coords.push(evt.coordinate);
    geometry.setCoordinates(coords);
    updateVertices();
    setGlobalSelected(vertexMap.findIndex(e => e.feature === selectedFeature && e.index === coords.length - 1));
    return;
  }

  // If a global vertex is selected within this feature, insert after that vertex
  if (globalSelectedIndex !== -1) {
    const entry = vertexMap[globalSelectedIndex];
    if (entry && entry.feature === selectedFeature) {
      // Use a copy of the coords array to avoid mutating references
      const newCoords = coords.slice();
      newCoords.splice(entry.index + 1, 0, evt.coordinate);
      geometry.setCoordinates(newCoords);
      updateVertices();
      setGlobalSelected(vertexMap.findIndex(e => e.feature === selectedFeature && e.index === entry.index + 1));
      return;
    }
  }

  // Default: append to the end
  coords.push(evt.coordinate);
  geometry.setCoordinates(coords);
  updateVertices();
  setGlobalSelected(vertexMap.findIndex(e => e.feature === selectedFeature && e.index === coords.length - 1));
});

// Double-click to finish trail as point (if only one vertex)
map.on('dblclick', function(evt) {
  if (!isCreatingTrail || !selectedFeature) return;
  
  const geometry = selectedFeature.getGeometry();
  if (geometry.getType() === 'LineString') {
    const coords = geometry.getCoordinates();
    if (coords.length === 1) {
      // Convert single point LineString to Point
      const point = new Point(coords[0]);
      selectedFeature.setGeometry(point);
      selectedFeature.setStyle(new Style({
        image: new CircleStyle({
          radius: 8,
          fill: new Fill({ color: 'blue' }),
          stroke: new Stroke({ color: 'white', width: 2 }),
        }),
      }));
      
      // Exit trail creation mode
      isCreatingTrail = false;
      document.body.style.cursor = 'auto';
      updateVertices();
      updateTextarea();
      evt.preventDefault(); // Prevent default double-click zoom
    }
  }
});

// CONTEXT MENU (right click)
map.getTargetElement().addEventListener('contextmenu', function (evt) {
  evt.preventDefault();

  if (selectedFeature) {
    contextMenu.style.left = `${evt.clientX}px`;
    contextMenu.style.top = `${evt.clientY}px`;
    contextMenu.style.display = 'block';
  } else {
    contextMenu.style.display = 'none';
    contextMenuTrail.style.left = `${evt.clientX}px`;
    contextMenuTrail.style.top = `${evt.clientY}px`;
    contextMenuTrail.style.display = 'block';
  }
});

// HIDE CONTEXT MENU
document.addEventListener('click', function (evt) {
  if (!contextMenu.contains(evt.target)) {
    contextMenu.style.display = 'none';
  }
});
document.addEventListener('click', function (evt) {
  if (!contextMenuTrail.contains(evt.target)) {
    contextMenuTrail.style.display = 'none';
  }
});

// Handle keyboard navigation for vertices across all trail features
document.addEventListener('keydown', function(evt) {
  if (!vertexMap || vertexMap.length === 0) return;

  if (!evt.ctrlKey) return; // only navigate with Ctrl+Arrow

  if (evt.key === 'ArrowLeft') {
    globalSelectedIndex = globalSelectedIndex <= 0 ? vertexMap.length - 1 : globalSelectedIndex - 1;
    setGlobalSelected(globalSelectedIndex);
  } else if (evt.key === 'ArrowRight') {
    globalSelectedIndex = globalSelectedIndex >= vertexMap.length - 1 ? 0 : globalSelectedIndex + 1;
    setGlobalSelected(globalSelectedIndex);
  }
});

// Keyboard shortcut: 'b' to split/create branch from the currently selected vertex
document.addEventListener('keydown', function(evt) {
  if (evt.key === 'b' || evt.key === 'B') {
    if (globalSelectedIndex !== -1) {
      const parentEntry = vertexMap[globalSelectedIndex];
      createBranchFromVertex(parentEntry);
      evt.preventDefault();
    }
  }
});

// Keyboard shortcut: 'p' to create a point from current trail
document.addEventListener('keydown', function(evt) {
  if ((evt.key === 'p' || evt.key === 'P') && isCreatingTrail && selectedFeature) {
    const geometry = selectedFeature.getGeometry();
    if (geometry.getType() === 'LineString') {
      const coords = geometry.getCoordinates();
      if (coords.length === 1) {
        // Convert single point LineString to Point
        const point = new Point(coords[0]);
        selectedFeature.setGeometry(point);
        selectedFeature.setStyle(new Style({
          image: new CircleStyle({
            radius: 8,
            fill: new Fill({ color: 'blue' }),
            stroke: new Stroke({ color: 'white', width: 2 }),
          }),
        }));
        
        // Exit trail creation mode
        isCreatingTrail = false;
        document.body.style.cursor = 'auto';
        updateVertices();
        updateTextarea();
        evt.preventDefault();
      }
    }
  }
});

// Keyboard shortcut: Enter to finish current trail
document.addEventListener('keydown', function(evt) {
  if (evt.key === 'Enter' && isCreatingTrail && selectedFeature) {
    const geometry = selectedFeature.getGeometry();
    if (geometry.getType() === 'LineString') {
      const coords = geometry.getCoordinates();
      if (coords.length === 1) {
        // Convert to point
        const point = new Point(coords[0]);
        selectedFeature.setGeometry(point);
        selectedFeature.setStyle(new Style({
          image: new CircleStyle({
            radius: 8,
            fill: new Fill({ color: 'blue' }),
            stroke: new Stroke({ color: 'white', width: 2 }),
          }),
        }));
      } else if (coords.length === 2) {
        // Keep as LineString but finish editing
        selectedFeature.setStyle(defaultStyle);
      }
      // For 3+ points, keep as LineString
      
      // Exit trail creation mode
      isCreatingTrail = false;
      document.body.style.cursor = 'auto';
      updateVertices();
      updateTextarea();
      evt.preventDefault();
    }
  }
});

// Keyboard shortcut: Backspace to delete the currently selected global vertex
document.addEventListener('keydown', function(evt) {
  if (evt.key === 'Backspace') {
    // Only act if a vertex is selected
    if (globalSelectedIndex === -1 || !vertexMap || vertexMap.length === 0) return;
    evt.preventDefault();

    const entry = vertexMap[globalSelectedIndex];
    if (!entry) return;

    const feat = entry.feature;
    const geom = feat && feat.getGeometry ? feat.getGeometry() : null;
    if (!geom) return;

    const geomType = geom.getType();
    
    if (geomType === 'Point') {
      vectorSource.removeFeature(feat);
      const ti = trailFeatures.indexOf(feat);
      if (ti !== -1) trailFeatures.splice(ti, 1);
      if (selectedFeature === feat) selectedFeature = null;

      if (trailFeatures.length === 0) {
        isCreatingTrail = false;
        document.body.style.cursor = 'auto';
        if (vertexLayer) {
          map.removeLayer(vertexLayer);
          vertexLayer = null;
        }
      }

      // Refresh UI and selections
      updateVertices();
      globalSelectedIndex = -1;
      updateTextarea();
      return;
    }

    let coords = [];
    let isPolygon = false;
    
    if (geomType === 'LineString') {
      coords = geom.getCoordinates().slice();
    } else if (geomType === 'Polygon') {
      coords = geom.getCoordinates()[0].slice(); // Get outer ring
      isPolygon = true;
    } else {
      return;
    }
    
    const delIdx = entry.index;

    // Remove the selected vertex
    if (isPolygon) {
      if (delIdx === 0 || delIdx === coords.length - 1) {
        // If deleting the start/end vertex, remove the first and ensure closed
        coords.splice(0, 1);
        if (coords.length > 0) {
          coords[coords.length - 1] = [...coords[0]];
        }
      } else {
        coords.splice(delIdx, 1);
      }
    } else {
      coords.splice(delIdx, 1);
    }

    // Convert polygon to linestring if not enough points
    let convertedToLineString = false;
    if (isPolygon && coords.length < 4) {
      coords.pop(); // Remove the closing duplicate point
      const newLineString = new LineString(coords);
      feat.setGeometry(newLineString);
      isPolygon = false;
      convertedToLineString = true;
    } else if (coords.length === 0) {
      vectorSource.removeFeature(feat);
      const ti = trailFeatures.indexOf(feat);
      if (ti !== -1) trailFeatures.splice(ti, 1);
      if (selectedFeature === feat) selectedFeature = null;

      if (trailFeatures.length === 0) {
        isCreatingTrail = false;
        document.body.style.cursor = 'auto';
        if (vertexLayer) {
          map.removeLayer(vertexLayer);
          vertexLayer = null;
        }
      }

      // Refresh UI and selections
      updateVertices();
      globalSelectedIndex = -1;
      updateTextarea();
      return;
    }

    // Otherwise update the geometry with the removed vertex (if not already converted)
    if (!convertedToLineString) {
      if (isPolygon) {
        geom.setCoordinates([coords]);
      } else {
        geom.setCoordinates(coords);
      }
    }

    // Adjust branchStart metadata if present
    const bs = feat.get('branchStart');
    if (bs !== undefined && bs !== null) {
      if (delIdx < bs) {
        feat.set('branchStart', bs - 1);
      }
      // If delIdx === bs we keep branchStart the same index because the next vertex
      // shifts into that position. If delIdx > bs no change.
    }

    // Refresh vertices and pick a sensible nearby selection (same index or previous)
    updateVertices();
    // Compute new selection index for the feature (cap to last available)
    const remainingCount = vertexMap.filter(e => e.feature === feat).length;
    const chooseIdx = Math.min(delIdx, Math.max(0, remainingCount - 1));
    const newG = vertexMap.findIndex(e => e.feature === feat && e.index === chooseIdx);
    if (newG !== -1) setGlobalSelected(newG); else {
      globalSelectedIndex = -1;
    }

    updateTextarea();
  }
});

// Function to highlight the selected vertex
function highlightVertex(index) {
  if (!vertexLayer || !selectedFeature) return;
  
  const coords = selectedFeature.getGeometry().getCoordinates();
  if (index < 0 || index >= coords.length) return;

  updateVertices();
  
  // Center the map on the selected vertex
  if (autoPanOnSelect) {
    map.getView().animate({ center: coords[index], duration: 200 });
  }
}

// CONTEXT MENU: TRAIL MODE (empty trail)
contextMenuTrail.addEventListener('click', function (evt) {
  const action = evt.target.getAttribute('data-action');
  if (action !== 'trail-mode') return;

  // Clear any existing selection state to ensure we start fresh
  selectedFeature = null;
  globalSelectedIndex = -1;
  trailFeatures.length = 0;
  isBranching = false;

  isCreatingTrail = true;
  document.body.style.cursor = 'crosshair';

  // Initialize with a first point at click location
  const newFeature = new Feature(new LineString([]));
  newFeature.setId(`trail-${Date.now()}`);
  newFeature.setStyle(selectedStyle);
  newFeature.set('isFirstPoint', true);

  vectorSource.addFeature(newFeature);
  trailFeatures.push(newFeature);
  selectedFeature = newFeature;

  // Create fresh vertex layer
  if (vertexLayer) map.removeLayer(vertexLayer);
  vertexLayer = new VectorLayer({ 
    source: new VectorSource(),
    style: new Style({
      image: new CircleStyle({
        radius: 6,
        fill: new Fill({ color: 'red' }),
        stroke: new Stroke({ color: 'white', width: 2 }),
      }),
    })
  });
  map.addLayer(vertexLayer);

  contextMenuTrail.style.display = 'none';
});

// CONTEXT MENU ACTIONS
contextMenu.addEventListener('click', function (evt) {
  const action = evt.target.getAttribute('data-action');
  if (!action || !selectedFeature) return;

  switch (action) {
    case 'Create trail': {
      const geomType = selectedFeature.getGeometry().getType();
      if (geomType === 'LineString' || geomType === 'Polygon' || geomType === 'Point') {
        // Enter trail-editing mode for the selected feature and show its vertices
        isCreatingTrail = true;
        
        if (geomType === 'LineString') {
          originalCoords = [...selectedFeature.getGeometry().getCoordinates()];
        } else if (geomType === 'Polygon') {
          originalCoords = [...selectedFeature.getGeometry().getCoordinates()[0]];
        } else if (geomType === 'Point') {
          originalCoords = [selectedFeature.getGeometry().getCoordinates()];
        }

        // Make the selected feature the only editable trail so updateVertices will render only its vertices
        trailFeatures.length = 0;
        trailFeatures.push(selectedFeature);

        // Ensure vertex layer and render vertices via updateVertices
        updateVertices();
        if (vertexMap.length > 0) {
          if (geomType === 'Polygon') {
            setGlobalSelected(Math.max(0, vertexMap.length - 2));
          } else {
            setGlobalSelected(vertexMap.length - 1);
          }
        } else {
          globalSelectedIndex = -1;
        }
      }
      break;
    }
    case 'Replace trail':
      if (isCreatingTrail) {
        // Check if this is a single-point LineString and convert to Point
        const geometry = selectedFeature.getGeometry();
        if (geometry.getType() === 'LineString') {
          const coords = geometry.getCoordinates();
          if (coords.length === 1) {
            selectedFeature.setGeometry(new Point(coords[0]));
          }
        }

        const originalCoords = selectedFeature.get('originalCoords');
        
        // Finalize trail editing without splitting: keep the extended segments as part of the same LineString.
        // If originalCoords exists it was stored for a potential split; we'll clear that marker and keep
        // the current coordinates on the same feature. Use explicit 'split-vertex' or keyboard 'B' to split later.
        if (originalCoords) {
          selectedFeature.unset('originalCoords');
          selectedFeature.unset('branchStart');
        }
        
        isCreatingTrail = false;

        if (vertexLayer) {
          map.removeLayer(vertexLayer);
          vertexLayer = null;
        }

        // update textarea with all features
        updateTextarea();
      }

  // Ensure visual state: deselect editing UI but keep the edited feature highlighted
  vectorSource.getFeatures().forEach(f => f.setStyle(defaultStyle));
  if (selectedFeature) selectedFeature.setStyle(selectedStyle);
      document.body.style.cursor = 'auto';
      break;

    case 'split-vertex': {
      // Create a separate branch feature starting at the currently selected global vertex
      if (globalSelectedIndex !== -1) {
        const parentEntry = vertexMap[globalSelectedIndex];
        createBranchFromVertex(parentEntry);
      }
      break;
    }

    case 'Deselect':
      if (isCreatingTrail) {
        if (originalCoords) {
          const geomType = selectedFeature.getGeometry().getType();
          if (geomType === 'Polygon') {
            selectedFeature.getGeometry().setCoordinates([originalCoords]);
          } else if (geomType === 'LineString' && originalCoords.length === 1) {
            selectedFeature.setGeometry(new Point(originalCoords[0]));
          } else {
            selectedFeature.getGeometry().setCoordinates(originalCoords);
          }
          originalCoords = null;
        } else {
          // If it's a new unsaved trail, remove it
          vectorSource.removeFeature(selectedFeature);
          const ti = trailFeatures.indexOf(selectedFeature);
          if (ti !== -1) trailFeatures.splice(ti, 1);
        }
        updateTextarea(); // Revert the exported GeoJSON state to match the undo
      }

      if (selectedFeature) {
        selectedFeature.setStyle(defaultStyle);
      }
      selectedFeature = null;
      if (vertexLayer) {
        map.removeLayer(vertexLayer);
        vertexLayer = null;
      }
      isCreatingTrail = false;
      document.body.style.cursor = 'auto';
      break;

    case 'trail-mode': {
      isCreatingTrail = true;
      originalCoords = [...selectedFeature.getGeometry().getCoordinates()];
      const coords = originalCoords.map(coord => [...coord]);
      const points = coords.map(coord => new Feature(new Point(coord)));

      const pointStyle = new Style({
        image: new CircleStyle({
          radius: 6,
          fill: new Fill({ color: 'red' }),
          stroke: new Stroke({ color: 'white', width: 2 }),
        }),
      });

      points.forEach(pt => pt.setStyle(pointStyle));

      if (vertexLayer) map.removeLayer(vertexLayer);
      vertexLayer = new VectorLayer({
        source: new VectorSource({ features: points }),
      });
      map.addLayer(vertexLayer);
      break;
    }
  }
  contextMenuTrail.style.display = "none";
  contextMenu.style.display = 'none';
});
