import * as THREE from 'three';
import type { Map as MapGL } from '@2gis/mapgl/types';

import { Evented } from './external/evented';
import { EventSource } from './eventSource';
import { Loader } from './loader';
import { PoiGroup } from './poiGroup';
import { defaultOptions } from './defaultOptions';

import type {
    PluginOptions,
    ModelOptions,
    BuildingState,
    AddPoiGroupOptions,
    RemovePoiGroupOptions,
} from './types/plugin';
import type { GltfPluginEventTable } from './types/events';
import { GltfFloorControl } from './control';

export class GltfPlugin extends Evented<GltfPluginEventTable> {
    private renderer = new THREE.WebGLRenderer();
    private camera = new THREE.PerspectiveCamera();
    private scene = new THREE.Scene();
    private tmpMatrix = new THREE.Matrix4();
    private viewport: DOMRect;
    private map: MapGL;
    private options = defaultOptions;
    private loader: Loader;
    private poiGroup: PoiGroup;
    private eventSource?: EventSource;
    private onPluginInit = () => {}; // resolve of waitForPluginInit
    private waitForPluginInit = new Promise<void>((resolve) => (this.onPluginInit = resolve));
    private models;
    private control?: GltfFloorControl;

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
            this.initEventHandlers();
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

                    const model = this.models.get(String(options.modelId));
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

            const model = this.models.get(String(options.modelId));
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

    public async addPoiGroup(options: AddPoiGroupOptions, state?: BuildingState) {
        await this.waitForPluginInit;

        this.poiGroup.addPoiGroup(options, state);
    }

    public removePoiGroup(options: RemovePoiGroupOptions) {
        this.poiGroup.removePoiGroup(options);
    }

    public async megaMethod(scene: any) {
        await this.waitForPluginInit;

        const { position } = this.options.floorsControl;
        this.control = new GltfFloorControl(this.map, { position });
        this.control.on('floorChange', (e) => {
            console.log(e);
        });
        this.control?.show({
            modelId: 777,
            floorId: 0,
            floorLevels: [
                {
                    icon: 'building',
                    text: '',
                },
                {
                    floorId: 0,
                    icon: 'parking',
                    text: '',
                },
                { floorId: 1, text: '1-9' },
                { floorId: 3, text: '10-11' },
                { floorId: 4, text: '12-13' },
                { floorId: 5, text: '14-15' },
                { floorId: 6, text: '16-19' },
                { floorId: 7, text: '20' },
                { floorId: 8, text: '21-22' },
                { floorId: 9, text: '23-25' },
                { floorId: 10, text: '25-30' },
                { floorId: 11, text: '31-34' },
                { floorId: 12, text: '35' },
            ],
        });
        this.eventSource?.setCurrentFloorId(1234342);
    }

    private invalidateViewport() {
        const container = this.map.getContainer();
        this.viewport = container.getBoundingClientRect();
        this.eventSource?.updateViewport(this.viewport);
    }

    private initEventHandlers() {
        this.map.on('resize', () => {
            this.invalidateViewport();
        });

        this.eventSource = new EventSource(this.map, this.viewport, this.camera, this.scene);
        for (let eventName of this.eventSource.getEvents()) {
            this.eventSource.on(eventName, (e) => {
                this.emit(eventName, e);
            });
        }
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
