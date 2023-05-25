import * as THREE from 'three';
import type { Map as MapGL, MapPointerEvent } from '@2gis/mapgl/types';

import { Evented } from './evented';
import { Loader } from './loader';
import { PoiGroup } from './poiGroup';
import { PluginOptions, ModelOptions, GltfPluginEventTable } from './types';

type Parameter<T extends (...args: any) => any> = Parameters<T>['0'];

const defaultOptions: Required<PluginOptions> = {
    ambientLight: {
        color: '#ffffff',
        intencity: 1,
    },
    dracoScriptsUrl: 'https://unpkg.com/@2gis/mapgl-gltf@^1/dist/libs/draco/',
    modelsBaseUrl: '',
    modelsLoadStrategy: 'waitAll',
    poiConfig: {
        primary: {
            fontSize: 14,
            fontColor: '#000000',
        },
        secondary: {
            fontSize: 14,
            fontColor: '#000000',
        },
    },
};

export class GltfPlugin extends Evented<GltfPluginEventTable> {
    private renderer = new THREE.WebGLRenderer();
    private camera = new THREE.PerspectiveCamera();
    private scene = new THREE.Scene();
    private tmpMatrix = new THREE.Matrix4();
    private raycaster = new THREE.Raycaster();
    private pointer = new THREE.Vector2();
    private viewport: ReturnType<HTMLElement['getBoundingClientRect']>;
    private map: MapGL;
    private options = defaultOptions;
    private loader: Loader;
    private poiGroup: PoiGroup;
    private onPluginInit = () => {}; // resolve of waitForPluginInit
    private waitForPluginInit = new Promise<void>((resolve) => (this.onPluginInit = resolve));
    private models;

    /**
     * Example:
     * ```js
     * const plugin = new GltfPlugin (map, {
     *     modelsLoadStrategy: 'waitAll',
     *     dracoScriptsUrl: 'libs/draco/',
     *     ambientLight: { color: 'white', intencity: 2.5 },
     * });
     *
     * plugin.addModels([
     *     {
     *         id: 1,
     *         coordinates: [82.886554, 54.980988],
     *         modelUrl: 'models/cube_draco.glb',
     *         rotateX: 90,
     *         scale: 1000,
     *     },
     * ]);
     * ```
     * @param map The map instance
     * @param pluginOptions GltfPlugin initialization options
     */
    constructor(map: MapGL, pluginOptions?: PluginOptions) {
        super();

        this.map = map;
        this.options = { ...this.options, ...pluginOptions };

        this.viewport = this.map.getContainer().getBoundingClientRect();

        this.loader = new Loader({
            modelsBaseUrl: this.options.modelsBaseUrl,
            dracoScriptsUrl: this.options.dracoScriptsUrl,
        });
        this.models = this.loader.getModels();

        this.poiGroup = new PoiGroup({
            map: this.map,
            poiConfig: this.options.poiConfig,
        });

        map.once('idle', () => {
            this.poiGroup.addIcons();
            this.addThreeJsLayer();
            this.bindEvents();
        });
    }

    /**
     * Add models to the map
     *
     * @param modelOptions An array of models' options
     */
    public async addModels(modelOptions: ModelOptions[]) {
        await this.waitForPluginInit;

        const loadedModels = modelOptions.map((options) => {
            return this.loader.loadModel(options).then(() => {
                if (this.options.modelsLoadStrategy === 'dontWaitAll') {
                    if (options.linkedIds) {
                        this.map.setHiddenObjects(options.linkedIds);
                    }

                    const model = this.models.get(String(options.id));
                    if (model !== undefined) {
                        this.scene.add(model);
                    }
                    this.map.triggerRerender();
                }
            });
        });

        return Promise.all(loadedModels).then(() => {
            if (this.options.modelsLoadStrategy === 'waitAll') {
                for (let options of modelOptions) {
                    if (options.linkedIds) {
                        this.map.setHiddenObjects(options.linkedIds);
                    }
                }
                for (let [_id, model] of this.models) {
                    this.scene.add(model);
                }
                this.map.triggerRerender();
            }
        });
    }

    public async addModel(options: ModelOptions) {
        await this.waitForPluginInit;
        return this.loader.loadModel(options).then(() => {
            if (options.linkedIds) {
                this.map.setHiddenObjects(options.linkedIds);
            }

            const model = this.models.get(String(options.id));
            if (model !== undefined) {
                this.scene.add(model);
            }
            this.map.triggerRerender();
        });
    }

    public removeModel(id: string | number) {
        const model = this.models.get(String(id));
        if (model === undefined) {
            return;
        }
        this.scene.remove(model);
        this.map.triggerRerender();
    }

    public async addPoiGroup(options: Parameter<PoiGroup['addPoiGroup']>) {
        await this.waitForPluginInit;

        this.poiGroup.addPoiGroup(options);
    }

    public removePoiGroup(options: Parameter<PoiGroup['removePoiGroup']>) {
        this.poiGroup.removePoiGroup(options);
    }

    private invalidateViewport() {
        const container = this.map.getContainer();
        this.viewport = container.getBoundingClientRect();
    }

    private getEventTargetMesh(e: MouseEvent | TouchEvent) {
        const { clientX, clientY } = 'changedTouches' in e ? e.changedTouches[0] : e;

        // coordinates of the cursor in local coordinates of map's viewport
        const localX = clientX - this.viewport.x;
        const localY = this.viewport.height - (clientY - this.viewport.y);

        // convert local coordinates of the corser to WebGL coordinates
        // and use it for the object identification in three.js-scene
        this.pointer.x = (localX / this.viewport.width) * 2 - 1;
        this.pointer.y = (localY / this.viewport.height) * 2 - 1;
        this.raycaster.setFromCamera(this.pointer, this.camera);
        const intersects = this.raycaster.intersectObjects(this.scene.children, true);
        const target = intersects[0] ? intersects[0] : undefined;

        if (!target || target.object.type !== 'Mesh') {
            return null;
        }

        return target;
    }

    private isGeoJsonPoi(e: MapPointerEvent) {
        return (
            e.targetData?.type === 'geojson' &&
            e.targetData?.feature?.properties?.type === 'immersive_poi'
        );
    }

    private bindEvents() {
        this.map.on('resize', () => {
            this.invalidateViewport();
        });

        /**
         * Poi events
         */
        this.map.on('mousemove', (e) => {
            if (this.isGeoJsonPoi(e)) {
                this.emit('mousemovePoi', e);
            }
        });

        this.map.on('mouseover', (e) => {
            if (this.isGeoJsonPoi(e)) {
                this.emit('mouseoverPoi', e);
            }
        });

        this.map.on('mouseout', (e) => {
            if (this.isGeoJsonPoi(e)) {
                this.emit('mouseoutPoi', e);
            }
        });

        this.map.on('click', (e) => {
            if (this.isGeoJsonPoi(e)) {
                this.emit('clickPoi', e);
            }
        });

        /**
         * Model events
         */
        this.map.on('click', (e) => {
            const target = this.getEventTargetMesh(e.originalEvent);

            if (target) {
                this.emit('clickModel', {
                    lngLat: e.lngLat,
                    point: e.point,
                    originalEvent: e.originalEvent,
                    target: {
                        id: target.object.userData.modelId,
                    },
                });
            }
        });

        this.map.on('mousemove', (e) => {
            const target = this.getEventTargetMesh(e.originalEvent);
            if (target) {
                console.log('hover over the model', Date.now());
            }
        })
    }

    private render() {
        this.camera.projectionMatrix.fromArray(this.map.getProjectionMatrixForGltfPlugin());
        this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();

        this.tmpMatrix.fromArray(this.map.getProjectionMatrix());
        this.camera.matrixWorldInverse.multiplyMatrices(
            this.camera.projectionMatrixInverse,
            this.tmpMatrix,
        );

        this.camera.matrixWorld.copy(this.camera.matrixWorldInverse).invert();
        this.camera.matrix.copy(this.camera.matrixWorld);
        this.camera.matrix.decompose(
            this.camera.position,
            this.camera.quaternion,
            this.camera.scale,
        );

        this.renderer.resetState();

        // setViewport discards the same settings
        // so it has no effect on performance
        this.renderer.setViewport(
            0,
            0,
            this.viewport.width * window.devicePixelRatio,
            this.viewport.height * window.devicePixelRatio,
        );

        this.renderer.render(this.scene, this.camera);
    }

    private initThree() {
        this.camera = new THREE.PerspectiveCamera();

        this.renderer = new THREE.WebGLRenderer({
            canvas: this.map.getCanvas(),
            context: this.map.getWebGLContext(),
            antialias: window.devicePixelRatio < 2,
        });
        this.renderer.autoClear = false;
        this.renderer.outputEncoding = THREE.sRGBEncoding;
        this.renderer.useLegacyLights = false;

        const { color, intencity } = this.options.ambientLight;
        const light = new THREE.AmbientLight(color, intencity);
        this.scene.add(light);

        this.onPluginInit();
    }

    private addThreeJsLayer() {
        this.map.addLayer({
            id: 'threeJsLayer',
            type: 'custom',
            onAdd: () => this.initThree(),
            render: () => this.render(),
            onRemove: () => {},
        });
    }
}
