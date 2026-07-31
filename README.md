# IMDF Builder for Microsoft Places

A user-friendly web application to create Indoor Mapping Data Format (IMDF) files for use with Microsoft Places. This tool provides a graphical interface for non-technical users to upload floor plans, place various indoor mapping elements, and generate standards-compliant IMDF files.

## About this fork

This is a fork of [loryanstrant/IMDF-Builder-for-Places](https://github.com/loryanstrant/IMDF-Builder-for-Places) with changes focused on getting exports to actually import and render in Microsoft Places, validated end-to-end against a real tenant:

- **Places-compatible export**: packages match the undocumented subset of IMDF that `Import-MapCorrelations` / `New-Map` accept (localized name dicts, null building geometry, exact property names, allowlisted files only). The exporter validates every package before download and reports real problems clearly instead of Places' misleading errors.
- **Streamlined import workflow**: enter PlaceIds in the UI (with paste/typo validation) and the export includes a pre-correlated `mapfeatures.csv`, so the `Import-MapCorrelations` extract pass isn't needed.
- **Auto-Trace Rooms**: detects rooms, the building outline, walls, and free-standing furniture from the uploaded floor plan using geometric wall detection. Seals door openings so real CAD plans trace cleanly, works at any page margin/scale, and every detected shape stays editable.
- **Full-floor partition**: auto-trace also covers the leftover circulation space with `walkway` units — corridors, lobbies, open areas — so the whole floor renders like professionally built Places maps, with walls appearing as the gaps between units. Walkways that wrap around room blocks are split into simple polygons at export (Places' importer fails on polygons with holes).
- **Recognisable furniture**: furniture clusters are decomposed into clean rectangles — a conference table with its chairs exports as one table and individual chairs instead of a single traced blob — and free-standing cubicle banks are traced with their cells kept open so cubicle outlines show on the map.
- **Bookable desk support**: sections (desk pools) with visible outlines, and furniture exported so it actually renders in Places, including auto-drawn desk icons with rotation.
- **Real-world scaling**: exports are scaled to the building's physical width, with pixel metrics and exact geometry entry for precise shapes.
- **Categories aligned with Places**: the workplace set (`conferenceroom`, `workspace`, `desk`) plus space categories (`walkway`, `lobby`, `lounge`, `kitchen`, `foodservice`, `phoneroom`, `mothersroom`, `nonpublic`, `storage`, …), with a Places-style colour preview in the editor so the canvas approximates how the imported map will look.
- **Editor improvements**: Alt+click cycles through overlapping shapes, and shape positions are restored correctly when loading a saved project.
- **Fixes**: startup crash (#9), floor plans not rendering (#4), and a multer security bump (CVE-2026-5038, CVE-2026-5079).

> **Note:** the pre-built `ghcr.io/loryanstrant/imdf-builder-for-places` Docker image is built from the upstream repository and does **not** include these changes. To run this fork, use the local install instructions or build the Docker image locally (`build: .` in `docker-compose.yml`).

## Features

- 🖼️ **Floor Plan Upload**: Upload PDF or image files of your floor plans
- 🪄 **Auto-Trace Rooms**: Automatically detect rooms, walkways, the building outline, cubicle banks, and furniture from the floor plan — the whole floor is partitioned into units, furniture is decomposed into clean table/chair/desk rectangles, and everything stays editable afterwards
- 🏢 **Interactive Editor**: Visual canvas-based editor for placing indoor mapping elements
- 🎨 **Category Colours**: every unit previews in a Places-like tint (walkway, workspace, conference room, kitchen, non-public, …) so the canvas approximates the imported map
- 📍 **IMDF Elements Support**:
  - Units (rooms, offices, conference rooms, walkways and other spaces)
  - Sections (desk pools for bookable desks)
  - Amenities (desks, seating, facilities)
  - Fixtures (furniture and bookable desks with rotation)
  - Openings (doors, entrances)
  - Levels (floors)
- 📐 **Real-World Scaling**: Exports scaled to the building's physical width; pixel metrics and exact geometry entry for precise shapes
- 💾 **Project Management**: Save and load projects for later editing
- 📦 **Export**: Generate complete, Places-validated IMDF packages plus a pre-correlated `mapfeatures.csv`
- 🌓 **Dark Mode**: Toggle in the header; remembers your choice and follows your OS preference
- 🐳 **Docker Support**: Easy deployment with Docker and Docker Compose


<img width="1280" height="720" alt="508439876-18132b6d-a9e5-442c-80ca-4a68871fbd1e" src="https://github.com/user-attachments/assets/d4df6899-b70f-451e-9d73-d1c2b2cf975a" />


## Quick Start

### Using Docker (Recommended)

The easiest way to run the application is using the pre-built Docker image from GitHub Container Registry:

1. **Install Docker Desktop**
   - Download from [docker.com](https://www.docker.com/products/docker-desktop)
   - Install and start Docker Desktop

2. **Run the Application**
   ```bash
   # Using Docker Compose (recommended)
   docker-compose up -d

   # Or using Docker directly
   docker run -d -p 3009:3009 -v $(pwd)/projects:/app/projects -v $(pwd)/uploads:/app/uploads ghcr.io/loryanstrant/imdf-builder-for-places:latest

   # The application will be available at http://localhost:3009
   ```

3. **Stop the Application**
   ```bash
   docker-compose down
   ```

**Note**: The pre-built image is automatically updated from the main branch. If you want to build locally instead, edit `docker-compose.yml` and uncomment the `build: .` line.

#### Configuration (optional)

Copy `.env.example` to `.env` (Docker Compose reads it automatically) to change:

| Variable | Default | Purpose |
|----------|---------|---------|
| `HOST_PORT` | `3009` | Host port the app is published on — change it if `3009` is already taken. |
| `TZ` | `UTC` | Container timezone, any IANA name (e.g. `Australia/Sydney`). |

```bash
cp .env.example .env
# edit .env, then:
docker-compose up -d
```

### Running Locally (Without Docker)

1. **Prerequisites**
   - Node.js 18 or higher
   - npm (comes with Node.js)

2. **Installation**
   ```bash
   # Clone the repository
   git clone https://github.com/loryanstrant/IMDF-Builder-for-Places.git
   cd IMDF-Builder-for-Places

   # Install dependencies
   npm install

   # Start the application
   npm start
   ```

3. **Access the Application**
   - Open your browser and navigate to `http://localhost:3009`

### Building Docker Image Locally (Optional)

If you want to build the Docker image yourself instead of using the pre-built one:

```bash
# Clone the repository
git clone https://github.com/loryanstrant/IMDF-Builder-for-Places.git
cd IMDF-Builder-for-Places

# Build the Docker image
docker build -t imdf-builder .

# Run the container
docker run -d -p 3009:3009 -v $(pwd)/projects:/app/projects -v $(pwd)/uploads:/app/uploads imdf-builder

# Or edit docker-compose.yml to use 'build: .' instead of the image
```

## How to Use

### Step 1: Create a New Project
1. Enter a project name in the "Project Name" field
2. Enter your building name, venue coordinates (latitude, longitude), and the building's width in meters — this scales the export to real-world size
3. Click "Save Project" to save your initial setup

### Step 2: Upload Floor Plan
1. Click "Choose File" in the Floor Plan section
2. Select a PDF or image file of your floor plan
3. Click "Upload" to load it onto the canvas

### Step 3: Add Levels
1. In the "Levels" section, enter a level name (e.g., "Ground Floor")
2. Enter the level number (0 for ground floor, 1 for first floor, etc.)
3. Click "Add Level"
4. Click on a level in the list to make it active for placing items

### Step 4: Place Items on the Floor Plan

The fastest way to start is **Auto-Trace Rooms**: it detects rooms (wall-following shapes), the building outline, walkway units covering the leftover circulation space (so the whole floor renders like a professionally built Places map, walls showing as the gaps between units), free-standing cubicle banks (traced with their cells kept open), and furniture decomposed into clean table/chair/desk rectangles. Every detected shape can be moved, resized, renamed, or deleted afterwards.

After tracing, set each room's category (restroom, conference room, kitchen, …) in its properties — Places tints rooms by category and draws icons for restrooms, elevators, and stairs.

To place items manually (or adjust after auto-tracing):
1. Select a tool from the "Place Items" section:
   - **Place Unit**: For rooms, offices, conference rooms
   - **Place Section**: For desk pools — the area a group of bookable desks sits in
   - **Place Amenity**: For desks, seating, facilities
   - **Place Fixture**: For walls, windows
   - **Place Opening**: For doors, entrances
2. Click on the canvas where you want to place the item
3. Use "Select Mode" to select and move items — **Alt+click** cycles through overlapping shapes under the cursor
4. Use the pixel metrics in the properties panel to enter exact position and size for a shape

### Step 5: Edit Item Properties
1. Click "Select Mode" button
2. Click on an item on the canvas
3. Edit properties in the "Selected Item Properties" panel:
   - Change the name
   - Update the category
4. Click "Update Properties" to save changes

### Step 6: Export IMDF Files
1. Click the "Export IMDF Files" button in the right sidebar
2. Two downloads are produced:
   - `imdf-export.zip` — the IMDF package Microsoft Places accepts:
     building.geojson, footprint.geojson, level.geojson, unit.geojson
     (plus section.geojson and fixture.geojson when sections or fixtures
     exist). Places rejects zips containing any other files, so nothing
     else is included.
   - `mapfeatures.csv` — a pre-filled correlations file for
     `Import-MapCorrelations` (see below)

Feature ids are stable: re-exporting the same project produces the same ids,
so a correlations CSV you have already filled in stays valid.

### Step 7: Import into Microsoft Places
The import correlates each IMDF feature to an object in the Places directory
(created with `New-Place`). Full reference:
[Configure Maps in Microsoft Places](https://learn.microsoft.com/en-us/microsoft-365/places/configure-maps-in-places).

1. Find your directory objects and their PlaceIds:
   ```powershell
   Get-PlaceV3 -AncestorId <buildingPlaceId> | ft DisplayName,PlaceId,Type,SortOrder
   ```
2. Enter the PlaceIds in the builder (all optional — you can also fill the CSV
   by hand): the building's ID under "Building Info", each floor's ID by
   clicking the level in the Levels list, each room's ID in the unit's
   properties panel. Then export again — `mapfeatures.csv` comes out
   pre-correlated. Rows may be left uncorrelated (blank PlaceId), but the
   building and every floor must be correlated before import.
3. Make sure each floor's `SortOrder` in the Places directory equals the
   level's number in the builder (`Set-PlaceV3 -Identity <floorPlaceId>
   -SortOrder <n>`), and each row's directory object matches its feature type
   (Building row → Building, Level row → Floor, Unit row → Room,
   Section row → Section).
4. For bookable desks: desks are located through their parent Section (desk
   pool). Draw a Section over the desk area and correlate it to that Section
   object's PlaceId — without it, reserving a desk reports it couldn't be
   located on the map. To show an individual desk, select its furniture
   shape, set the category to **Desk**, and paste the Desk object's PlaceId
   into its Places ID field (naming the shape after the directory object is
   recommended). Places then draws its own desk icon there and colours it by
   live availability — green when free, red when reserved.
5. Run the correlation and create the map:
   ```powershell
   Import-MapCorrelations -FilePath .\imdf-export.zip -CorrelationsFilePath .\mapfeatures.csv
   New-Map -BuildingId <buildingPlaceId> -FilePath .\imdf_correlated.zip
   ```
6. The map can take up to an hour to appear in Places.

> **Note:** Places enforces an undocumented subset of the IMDF spec and
> reports violations with misleading errors (an unrecognised property fails
> `New-Map` with "Invalid JSON format ... Expected token '}' not found" even
> though the JSON is valid). The exporter validates every package against the
> known-accepted schema before download and reports real problems clearly.

## IMDF Compliance

This tool generates files that comply with the IMDF (Indoor Mapping Data Format) specification as required by Microsoft Places. All generated files include:

- Proper GeoJSON structure
- Unique UUIDs for all features
- Required properties for each feature type
- WGS84 coordinate system (latitude/longitude)
- Relationships between features

## Project Structure

```
IMDF-Builder-for-Places/
├── server.js              # Express.js backend server
├── public/                # Frontend files
│   ├── index.html        # Main HTML page
│   ├── css/
│   │   └── styles.css    # Application styles
│   └── js/
│       └── app.js        # Application logic
├── uploads/              # Uploaded floor plans (created at runtime)
├── projects/             # Saved projects (created at runtime)
├── package.json          # Node.js dependencies
├── Dockerfile            # Docker configuration
└── docker-compose.yml    # Docker Compose configuration
```

## Technical Details

### Backend (Node.js/Express)
- File upload handling with Multer
- Project persistence as JSON files
- IMDF file generation
- ZIP archive creation for exports

### Frontend
- HTML5/CSS3/JavaScript
- Fabric.js for canvas-based editing
- Responsive design
- No framework dependencies for simplicity

### Docker
- Based on Node.js 18 Alpine image
- Lightweight and efficient
- Persistent volumes for projects and uploads
- Available on GitHub Container Registry (GHCR)
- Image: `ghcr.io/loryanstrant/imdf-builder-for-places:latest`

**Available Image Tags:**
- `latest` - Latest build from the main branch
- `main` - Latest build from the main branch (same as latest)
- `v*.*.*` - Specific version tags (when releases are created)

**Pulling the Image:**
```bash
# Pull the latest version
docker pull ghcr.io/loryanstrant/imdf-builder-for-places:latest

# Pull a specific version (example)
docker pull ghcr.io/loryanstrant/imdf-builder-for-places:v1.0.0
```

## Browser Compatibility

- Chrome (recommended)
- Firefox
- Safari
- Edge

## Troubleshooting

### Issue: Cannot upload floor plan
- Check file size (max 50MB)
- Ensure file is PDF, PNG, or JPEG format
- Both raster images (PNG/JPEG) and PDFs are supported. For a PDF, the **first page** is
  rendered onto the canvas.

### Issue: Docker container won't start
- Ensure Docker Desktop is running
- Check if port 3009 is available — or set `HOST_PORT` in `.env` to a free port
- Try `docker-compose down` and `docker-compose up -d`

### Issue: Items not appearing on canvas
- Ensure you've added and selected a level first
- Check that the correct tool is selected

## Contributing

Contributions are welcome! Please feel free to submit issues or pull requests.

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Support

For issues, questions, or suggestions, please open an issue on GitHub.

## References

- [Microsoft Places Documentation](https://learn.microsoft.com/en-us/microsoft-365/places/)
- [Configure Maps in Microsoft Places](https://learn.microsoft.com/en-us/microsoft-365/places/configure-maps-in-places)
- [IMDF Specification](https://register.apple.com/resources/imdf/)
