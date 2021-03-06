require("ember-data/system/model_array");
require("ember-data/system/transaction");

var get = SC.get, set = SC.set, getPath = SC.getPath, fmt = SC.String.fmt;

var OrderedSet = SC.Object.extend({
  init: function() {
    this.clear();
  },

  clear: function() {
    this.set('presenceSet', {});
    this.set('list', SC.NativeArray.apply([]));
  },

  add: function(obj) {
    var guid = SC.guidFor(obj),
        presenceSet = get(this, 'presenceSet'),
        list = get(this, 'list');

    if (guid in presenceSet) { return; }

    presenceSet[guid] = true;
    list.pushObject(obj);
  },

  remove: function(obj) {
    var guid = SC.guidFor(obj),
        presenceSet = get(this, 'presenceSet'),
        list = get(this, 'list');

    delete presenceSet[guid];
    list.removeObject(obj);
  },

  isEmpty: function() {
    return getPath(this, 'list.length') === 0;
  },

  forEach: function(fn, self) {
    get(this, 'list').forEach(function(item) {
      fn.call(self, item);
    });
  }
});

// Implementors Note:
//
//   The variables in this file are consistently named according to the following
//   scheme:
//
//   * +id+ means an identifier managed by an external source, provided inside the
//     data hash provided by that source.
//   * +clientId+ means a transient numerical identifier generated at runtime by
//     the data store. It is important primarily because newly created objects may
//     not yet have an externally generated id.
//   * +type+ means a subclass of DS.Model.

/**
  The store contains all of the hashes for data models loaded from the server.
  It is also responsible for creating instances of DS.Model when you request one
  of these data hashes, so that they can be bound to in your Handlebars templates.

  Create a new store like this:

       MyApp.store = DS.Store.create();

  You can retrieve DS.Model instances from the store in several ways. To retrieve
  a model for a specific id, use the `find()` method:

       var model = MyApp.store.find(MyApp.Contact, 123);

   By default, the store will talk to your backend using a standard REST mechanism.
   You can customize how the store talks to your backend by specifying a custom adapter:

       MyApp.store = DS.Store.create({
         adapter: 'MyApp.CustomAdapter'
       });

    You can learn more about writing a custom adapter by reading the `DS.Adapter`
    documentation.
*/
DS.Store = SC.Object.extend({

  /**
    Many methods can be invoked without specifying which store should be used.
    In those cases, the first store created will be used as the default. If
    an application has multiple stores, it should specify which store to use
    when performing actions, such as finding records by id.

    The init method registers this store as the default if none is specified.
  */
  init: function() {
    if (!get(DS, 'defaultStore') || get(this, 'isDefaultStore')) {
      set(DS, 'defaultStore', this);
    }

    set(this, 'data', []);
    set(this, 'ids', {});
    set(this, 'models', []);
    set(this, 'modelArrays', []);
    set(this, 'modelArraysByClientId', {});
    set(this, 'defaultTransaction', DS.Transaction.create({ store: this }));

    return this._super();
  },

  transaction: function() {
    return DS.Transaction.create({ store: this });
  },

  modelArraysForClientId: function(clientId) {
    var modelArrays = get(this, 'modelArraysByClientId');
    var ret = modelArrays[clientId];

    if (!ret) {
      ret = modelArrays[clientId] = OrderedSet.create();
    }

    return ret;
  },

  /**
    The adapter to use to communicate to a backend server or other persistence layer.

    This can be specified as an instance, a class, or a property path that specifies
    where the adapter can be located.

    @property {DS.Adapter|String}
  */
  adapter: null,

  _adapter: SC.computed(function() {
    var adapter = get(this, 'adapter');
    if (typeof adapter === 'string') {
      return getPath(this, adapter);
    }
    return adapter;
  }).property('adapter').cacheable(),

  clientIdCounter: -1,

  // ....................
  // . CREATE NEW MODEL .
  // ....................

  createRecord: function(type, hash, transaction) {
    hash = hash || {};

    var id = hash[getPath(type, 'proto.primaryKey')] || null;

    var model = type.create({
      data: hash || {},
      store: this,
      transaction: transaction
    });

    model.adapterDidCreate();

    var data = this.clientIdToHashMap(type);
    var models = get(this, 'models');

    var clientId = this.pushHash(hash, id, type);

    set(model, 'clientId', clientId);

    models[clientId] = model;
    
    this.updateModelArrays(type, clientId, hash);

    return model;
  },

  // ................
  // . DELETE MODEL .
  // ................

  deleteRecord: function(model) {
    model.deleteRecord();
  },

  // ...............
  // . FIND MODELS .
  // ...............

  /**
    Finds a model by its id. If the data for that model has already been
    loaded, an instance of DS.Model with that data will be returned
    immediately. Otherwise, an empty DS.Model instance will be returned in
    the loading state. As soon as the requested data is available, the model
    will be moved into the loaded state and all of the information will be
    available.

    Note that only one DS.Model instance is ever created per unique id for a
    given type.

    Example:

        var record = MyApp.store.find(MyApp.Person, 1234);

    @param {DS.Model} type
    @param {String|Number} id
  */
  find: function(type, id, query) {
    if (id === undefined) {
      return this.findMany(type, null, null);
    }

    if (query !== undefined) {
      return this.findMany(type, id, query);
    } else if (SC.typeOf(id) === 'object') {
      return this.findQuery(type, id);
    }

    if (SC.isArray(id)) {
      return this.findMany(type, id);
    }

    var clientId = this.clientIdForId(type, id);

    return this.findByClientId(type, clientId, id);
  },

  findByClientId: function(type, clientId, id) {
    var model;

    var models = get(this, 'models');
    var data = this.clientIdToHashMap(type);

    // If there is already a clientId assigned for this
    // type/id combination, try to find an existing
    // model for that id and return. Otherwise,
    // materialize a new model and set its data to the
    // value we already have.
    if (clientId !== undefined) {
      model = models[clientId];

      if (!model) {
        // create a new instance of the model in the
        // 'isLoading' state
        model = this.createModel(type, clientId);

        // immediately set its data
        model.setData(data[clientId] || null);
      }
    } else {
      clientId = this.pushHash(null, id, type);

      // create a new instance of the model in the
      // 'isLoading' state
      model = this.createModel(type, clientId);

      // let the adapter set the data, possibly async
      var adapter = get(this, '_adapter');
      if (adapter && adapter.find) { adapter.find(this, type, id); }
      else { throw fmt("Adapter is either null or do not implement `find` method", this); }
    }

    return model;
  },

  /** @private
  */
  findMany: function(type, ids, query) {
    var idToClientIdMap = this.idToClientIdMap(type);
    var data = this.clientIdToHashMap(type), needed;

    var clientIds = Ember.A([]);

    if (ids) {
      needed = [];

      ids.forEach(function(id) {
        var clientId = idToClientIdMap[id];
        if (clientId === undefined || data[clientId] === undefined) {
          clientId = this.pushHash(null, id, type);
          needed.push(id);
        }

        clientIds.push(clientId);
      }, this);
    } else {
      needed = null;
    }

    if ((needed && get(needed, 'length') > 0) || query) {
      var adapter = get(this, '_adapter');
      if (adapter && adapter.findMany) { adapter.findMany(this, type, needed, query); }
      else { throw fmt("Adapter is either null or do not implement `findMany` method", this); }
    }

    return this.createModelArray(type, clientIds);
  },

  findQuery: function(type, query) {
    var array = DS.AdapterPopulatedModelArray.create({ type: type, content: Ember.A([]), store: this });
    var adapter = get(this, '_adapter');
    if (adapter && adapter.findQuery) { adapter.findQuery(this, type, query, array); }
    else { throw fmt("Adapter is either null or do not implement `findQuery` method", this); }
    return array;
  },

  findAll: function(type) {
    var array = DS.ModelArray.create({ type: type, content: Ember.A([]), store: this });
    this.registerModelArray(array, type);

    var adapter = get(this, '_adapter');
    if (adapter && adapter.findAll) { adapter.findAll(this, type); }

    return array;
  },

  filter: function(type, filter) {
    var array = DS.FilteredModelArray.create({ type: type, content: Ember.A([]), store: this, filterFunction: filter });

    this.registerModelArray(array, type, filter);

    return array;
  },

  // ............
  // . UPDATING .
  // ............

  hashWasUpdated: function(type, clientId) {
    var clientIdToHashMap = this.clientIdToHashMap(type);
    var hash = clientIdToHashMap[clientId];

    this.updateModelArrays(type, clientId, hash);
  },

  // ..............
  // . PERSISTING .
  // ..............

  commit: function() {
    get(this, 'defaultTransaction').commit();
  },

  didUpdateRecords: function(array, hashes) {
    if (arguments.length === 2) {
      array.forEach(function(model, idx) {
        this.didUpdateRecord(model, hashes[idx]);
      }, this);
    } else {
      array.forEach(function(model) {
        this.didUpdateRecord(model);
      }, this);
    }
  },

  didUpdateRecord: function(model, hash) {
    if (arguments.length === 2) {
      var clientId = get(model, 'clientId');
      var data = this.clientIdToHashMap(model.constructor);

      data[clientId] = hash;
      model.set('data', hash);
    }

    model.adapterDidUpdate();
  },

  didDeleteRecords: function(array) {
    array.forEach(function(model) {
      model.adapterDidDelete();
    });
  },

  didDeleteRecord: function(model) {
    model.adapterDidDelete();
  },

  didCreateRecords: function(type, array, hashes) {
    var id, clientId, primaryKey = getPath(type, 'proto.primaryKey');

    var idToClientIdMap = this.idToClientIdMap(type);
    var data = this.clientIdToHashMap(type);
    var idList = this.idList(type);

    for (var i=0, l=get(array, 'length'); i<l; i++) {
      var model = array[i], hash = hashes[i];
      id = hash[primaryKey];
      clientId = get(model, 'clientId');

      data[clientId] = hash;
      set(model, 'data', hash);

      idToClientIdMap[id] = clientId;
      idList.push(id);

      model.adapterDidUpdate();
    }
  },

  didCreateRecord: function(model, hash) {
    var type = model.constructor;

    var id, clientId, primaryKey = getPath(type, 'proto.primaryKey');

    var idToClientIdMap = this.idToClientIdMap(type);
    var data = this.clientIdToHashMap(type);
    var idList = this.idList(type);

    id = hash[primaryKey];

    clientId = get(model, 'clientId');
    data[clientId] = hash;
    set(model, 'data', hash);

    idToClientIdMap[id] = clientId;
    idList.push(id);

    model.adapterDidUpdate();
  },

  recordWasInvalid: function(record, errors) {
    record.wasInvalid(errors);
  },

  // ................
  // . MODEL ARRAYS .
  // ................

  registerModelArray: function(array, type, filter) {
    var modelArrays = get(this, 'modelArrays');
    var idToClientIdMap = this.idToClientIdMap(type);

    modelArrays.push(array);

    this.updateModelArrayFilter(array, type, filter);
  },

  createModelArray: function(type, clientIds) {
    var array = DS.ModelArray.create({ type: type, content: clientIds, store: this });

    clientIds.forEach(function(clientId) {
      var modelArrays = this.modelArraysForClientId(clientId);
      modelArrays.add(array);
    }, this);

    return array;
  },

  updateModelArrayFilter: function(array, type, filter) {
    var data = this.clientIdToHashMap(type);
    var allClientIds = this.clientIdList(type);

    for (var i=0, l=allClientIds.length; i<l; i++) {
      clientId = allClientIds[i];

      hash = data[clientId];

      if (hash) {
        this.updateModelArray(array, filter, type, clientId, hash);
      }
    }
  },

  updateModelArrays: function(type, clientId, hash) {
    var modelArrays = get(this, 'modelArrays');

    modelArrays.forEach(function(array) {
          modelArrayType = get(array, 'type');
          filter = get(array, 'filterFunction');

      if (type !== modelArrayType) { return; }

      this.updateModelArray(array, filter, type, clientId, hash);
    }, this);
  },

  updateModelArray: function(array, filter, type, clientId, hash) {
    var shouldBeInArray;

    if (!filter) {
      shouldBeInArray = true;
    } else {
      shouldBeInArray = filter(hash);
    }

    var content = get(array, 'content');
    var alreadyInArray = content.indexOf(clientId) !== -1;

    var modelArrays = this.modelArraysForClientId(clientId);

    if (shouldBeInArray && !alreadyInArray) {
      modelArrays.add(array);
      content.pushObject(clientId);
    } else if (!shouldBeInArray && alreadyInArray) {
      modelArrays.remove(array);
      content.removeObject(clientId);
    }
  },

  removeFromModelArrays: function(model) {
    var clientId = get(model, 'clientId');
    var modelArrays = this.modelArraysForClientId(clientId);

    modelArrays.forEach(function(array) {
      var content = get(array, 'content');
      content.removeObject(clientId);
    });
  },

  // ............
  // . TYPE MAP .
  // ............

  typeMap: function(type) {
    var ids = get(this, 'ids');
    var guidForType = SC.guidFor(type);

    var idToClientIdMap = ids[guidForType];

    if (idToClientIdMap) {
      return idToClientIdMap;
    } else {
      return (ids[guidForType] =
        {
          idToCid: {},
          idList: [],
          cidList: [],
          cidToHash: {}
      });
    }
  },

  idToClientIdMap: function(type) {
    return this.typeMap(type).idToCid;
  },

  idList: function(type) {
    return this.typeMap(type).idList;
  },

  clientIdList: function(type) {
    return this.typeMap(type).cidList;
  },

  clientIdToHashMap: function(type) {
    return this.typeMap(type).cidToHash;
  },

  /** @private

    For a given type and id combination, returns the client id used by the store.
    If no client id has been assigned yet, `undefined` is returned.

    @param {DS.Model} type
    @param {String|Number} id
  */
  clientIdForId: function(type, id) {
    return this.typeMap(type).idToCid[id];
  },

  idForHash: function(type, hash) {
    var primaryKey = getPath(type, 'proto.primaryKey');

    ember_assert("A data hash was loaded for a model of type " + type.toString() + " but no primary key '" + primaryKey + "' was provided.", !!hash[primaryKey]);
    return hash[primaryKey];
  },

  // ................
  // . LOADING DATA .
  // ................

  /**
    Load a new data hash into the store for a given id and type combination.
    If data for that model had been loaded previously, the new information
    overwrites the old.

    If the model you are loading data for has outstanding changes that have not
    yet been saved, an exception will be thrown.

    @param {DS.Model} type
    @param {String|Number} id
    @param {Object} hash the data hash to load
  */
  load: function(type, id, hash) {
    if (hash === undefined) {
      hash = id;
      var primaryKey = getPath(type, 'proto.primaryKey');
      ember_assert("A data hash was loaded for a model of type " + type.toString() + " but no primary key '" + primaryKey + "' was provided.", !!hash[primaryKey]);
      id = hash[primaryKey];
    }

    var ids = get(this, 'ids');
    var data = this.clientIdToHashMap(type);
    var models = get(this, 'models');

    var clientId = this.clientIdForId(type, id);

    if (clientId !== undefined) {
      data[clientId] = hash;

      var model = models[clientId];
      if (model) {
        model.willLoadData();
        model.setData(hash);
      }
    } else {
      clientId = this.pushHash(hash, id, type);
    }

    this.updateModelArrays(type, clientId, hash);

    return { id: id, clientId: clientId };
  },

  loadMany: function(type, ids, hashes) {
    var clientIds = Ember.A([]);

    if (hashes === undefined) {
      hashes = ids;
      ids = [];
      var primaryKey = getPath(type, 'proto.primaryKey');

      ids = hashes.map(function(hash) {
        ember_assert("A data hash was loaded for a model of type " + type.toString() + " but no primary key '" + primaryKey + "' was provided.", !!hash[primaryKey]);
        return hash[primaryKey];
      });
    }

    for (var i=0, l=get(ids, 'length'); i<l; i++) {
      var loaded = this.load(type, ids[i], hashes[i]);
      clientIds.pushObject(loaded.clientId);
    }

    return { clientIds: clientIds, ids: ids };
  },

  /** @private

    Stores a data hash for the specified type and id combination and returns
    the client id.

    @param {Object} hash
    @param {String|Number} id
    @param {DS.Model} type
    @returns {Number}
  */
  pushHash: function(hash, id, type) {
    var idToClientIdMap = this.idToClientIdMap(type);
    var clientIdList = this.clientIdList(type);
    var idList = this.idList(type);
    var data = this.clientIdToHashMap(type);

    var clientId = this.incrementProperty('clientIdCounter');

    data[clientId] = hash;

    // if we're creating an item, this process will be done
    // later, once the object has been persisted.
    if (id) {
      idToClientIdMap[id] = clientId;
      idList.push(id);
    }

    clientIdList.push(clientId);

    return clientId;
  },

  // .........................
  // . MODEL MATERIALIZATION .
  // .........................

  createModel: function(type, clientId) {
    var model;

    get(this, 'models')[clientId] = model = type.create({ store: this, clientId: clientId });
    set(model, 'clientId', clientId);
    model.loadingData();
    return model;
  }
});

