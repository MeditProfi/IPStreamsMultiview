define(["jquery", "jquery.cookie", "purl", "json!app/config.json?t=" + (new Date()).getTime()], function($, cookie, purl, config) {
	"use strict"

	var STREAMS_NUMBER = 12;
	var DEFAULT_PAGE = 1;
	var DEFAULT_PAGES_NUMBER = 1;
	var DEFAULT_UPDATE_INTERVAL = 2;
	var DEFAULT_FULLSCREEN_RESOLUTION_X = 1920;
	var DEFAULT_FULLSCREEN_RESOLUTION_Y = 1080;

	var Token;
	var ComponentContainer;
	var RequestInProgress = false;
	var Players = {};
	var BackgroundPlayers = {};
	var Streams = {};
	var URI_PARAMS = {
			"mode" : "multiscreen",
			"page" : DEFAULT_PAGE
		};
	var FirstPageIdx, LastPageIdx, TotalLastIdx;
	var Slots = [];

	function Init() {
		getContainer();
		getToken();
		getParams();
		setIndicies();
		initZonesMap();
		modeSpecificInit();
		startUpdating();
	}

	function getContainer() {
		ComponentContainer = $("#msp-container");
		if(ComponentContainer.length === 0)
			throw 'Init failed - element with id "msp-container" was not found';
	}

	function getToken() {
		Token = $.cookie("access_token");
	}

	function getParams() {
		var params = $.url().param();
		for (var k in params) {
			if(params.hasOwnProperty(k))
				URI_PARAMS[k] = params[k];
		}
	}

	function setIndicies() {
		LastPageIdx = URI_PARAMS["page"] * STREAMS_NUMBER - 1;
		FirstPageIdx = LastPageIdx - STREAMS_NUMBER + 1;
		TotalLastIdx = (config.Client.PagesNumber || DEFAULT_PAGES_NUMBER) * STREAMS_NUMBER;
	}

	function initZonesMap() {
		if(config.Zones == undefined)
			return;
		jQuery.each(config.Zones, function(name, zone) {
			if(zone.Slots == undefined)
				return true;
			jQuery.each(zone.Slots, function(idx, descr) {
				if(descr.Pos == undefined)
					return true;
				var slotDescr = {"zone" : name, "name" : descr.Name || idx};
				Slots[descr.Pos - 1] = slotDescr;
			});
		});
	}

	function modeSpecificInit() {
		if(isMultiscreenMode())
			createPlayerContainers();
		else if(isTableMode()) {
			setTableStyle();
			addMultiscreenLinks();
		} else if(isSingleStreamMode())
			startFullScreenPlayer();
		else
			throw 'Init failed - unknown mode "' + _currentMode() + '"';
	}

	function _currentMode() { return URI_PARAMS["mode"] }

	function isMultiscreenMode() { return  _currentMode() === 'multiscreen' }
	function isTableMode() { return _currentMode() === 'table' }
	function isSingleStreamMode() { return _currentMode() === 'single' }

	function createPlayerContainers() {
		for(var i=0;i<STREAMS_NUMBER;i++)
			addPlayerContainer(FirstPageIdx + i);
		ComponentContainer.append($('<div class="common-info"></div>'));
	}

	function setTableStyle() {
		$("body").addClass("table-view");
	}

	function startFullScreenPlayer() {
		$("body").addClass("single-player-view");
		var FullScreenRes = _getConfigFullscreenResolution();
		var p = jwplayer("msp-container").setup({
			flashplayer: "player.swf",
			playlist: [{
				file: URI_PARAMS["name"],
				type: "rtmp"
			}],
			rtmp: {
				bufferlength: 0.1
			},
			width: FullScreenRes.X,
			height: FullScreenRes.Y,
			streamer: _auth_protected_url(URI_PARAMS),
			controls: true,
			mute: false,
		});
		try {
			p.play();
		} catch(e) {
		}
	}

	function _getConfigFullscreenResolution() {
		var res = config.Client.FullScreenResolution;
		return { X : (res && res.X) ? res.X : DEFAULT_FULLSCREEN_RESOLUTION_X, Y : (res && res.Y) ? res.Y : DEFAULT_FULLSCREEN_RESOLUTION_Y }
	}

	function addPlayerContainer(idx) {
		var playerContainer = $('<div class="player-container">' +
				'<div id="player' + Math.floor(Math.random() * 1000000) + '"></div>' +
				'<div class="stream-info"></div>' +
				'<div class="stream-title"></div>' +
			'</div>');
		ComponentContainer.append(playerContainer);
		if(!(Slots[idx] && config.Zones[Slots[idx].zone]))
			return;
		var zoneInfo = config.Zones[Slots[idx].zone];
		var titleContainer = playerContainer.children(".stream-title");
		titleContainer.css({"background-color": zoneInfo.Color});
		titleContainer.addClass(zoneInfo.Class);
		titleContainer.html('<a href="#">' + Slots[idx].name + '</a>');
		if(zoneInfo.BackgroundStream)
			startBackgroundPlayer({slotIdx: idx, container: playerContainer, stream: zoneInfo.BackgroundStream});
	}

	function startUpdating() { setInterval(getStreamsInfo, (config.Client.UpdateInterval || DEFAULT_UPDATE_INTERVAL) * 1000) }

	function getStreamsInfo() {
		if(RequestInProgress)
			return
		RequestInProgress = true;
		$.ajax(config.Client.StreamsInfoAddr, {
				error: printUpdateErrors,
				success: updateStreams,
				complete: function() { RequestInProgress = false },
				dataType: "xml"
		});
	}

	function printUpdateErrors(xhr, statusText, error) {
		var errorString = (xhr.status === 200)  ?
			statusText + " (" + error + ")" :
			xhr.status + " (" + xhr.statusText + ")";
		console.log("Streams info update failed: " + errorString);
	}

	function updateStreams(data) {
		var streams = parseStreamsInfo(data);
		if(isMultiscreenMode())
			updatePlayers(streams);
		else if(isTableMode())
			updateList(streams);
	}

	function updatePlayers(streams) {
		updateSlotsState(streams);
		closeInactivePlayers(streams);
		openPlayersForNewStreams(streams);
	}

	function updateList(streams) {
		removeOldStreamsFromList(streams);
		addNewStreamsToList(streams);
	}

	function addMultiscreenLinks() {
		for(var i=(config.Client.PagesNumber || DEFAULT_PAGES_NUMBER);i>0;i--) {
			var linkElement = $(
				"<div class='link-multiscreen'>" +
					"<a href='" + window.location.pathname + "?mode=multiscreen&page=" + i + "'>" +
						"PAGE " + i + 
					"</a>" +
				"</div>");
			ComponentContainer.prepend(linkElement);
		}
	}

	function removeOldStreamsFromList(streams) {
		var oldStreamsList = ComponentContainer.find(".link-stream");
		oldStreamsList.each(function(idx, containerElement) {
			var container = $(containerElement);
			var streamURL = container.data("bcme-msp-stream-url");
			if(streamURL === undefined)
				return true;
			if(streams[streamURL] !== undefined)
				return true;
			container.remove();
		});
	}

	function addNewStreamsToList(streams) {
		jQuery.each(streams, function(streamURL, stream) {
			var container = getStreamLinkByURL(streamURL);
			if(container.length !== 0)
				return true;
			if(!shouldShowStream(stream))
				return;
			var linkElement = createStreamLinkElement(stream);
			ComponentContainer.append(linkElement);
		});
	}

	function getStreamLinkByURL(streamURL) {
		return ComponentContainer
			.find(".link-stream")
			.filter(function() { return $(this).data("bcme-msp-stream-url") == streamURL })
			.first();
	}

	function shouldShowStream(stream) {
		return (config.Zones[stream.zone] === undefined) ? 0 : 1;
	}

	function createStreamLinkElement(stream) {
		var linkContainer = $('<div class="link-stream"></div>');
		linkContainer.html('<a href="' + makeFullscreenURLLink(stream) + '">' + makeFullStreamName(stream) + '</a>');
		var streamURL = stream.fullURL;
		linkContainer.data("bcme-msp-stream-url", streamURL);
		return linkContainer;
	}

	function parseStreamsInfo(data) {
		var streams = {};
		$(data).find("server").each(function(idx, srv) {
			var explicitAddr = $(srv).attr('addr');
			var addr = explicitAddr ? explicitAddr : (config.Client.DefaultStreamerAddr === undefined) ? document.location.hostname : config.Client.DefaultStreamerAddr;
			var serverConfig = config.Servers[addr];
			var srvStreams = getServerStreams(srv);
			jQuery.each(srvStreams, function(name, stream) {
				stream.url = ((serverConfig.RelayAddr == undefined) ? addr : serverConfig.RelayAddr) + ':' +
					((serverConfig.Port === undefined) ? "1935" : serverConfig.Port) + '/' +
					stream.app;
				var streamConfig = serverConfig.Apps[stream.app];
				stream.zone = (streamConfig && streamConfig.Zone) ? streamConfig.Zone : '';
				stream.server = addr;
				stream.fullURL = _makeFullURL(stream);
				stream.isRedirected = stream.name.match(/\@/);
				streams[stream.fullURL] = stream;
			});
		});
		Streams = streams;
		return streams;
	}

	function _makeFullURL(stream) {
		return stream.url + '/' + stream.name;
	}

	function getServerStreams(srv) {
		var streams = {};
		$(srv).find("application").each(function(idx, app) {
			var appStreams = getAppStreams($(app));
			jQuery.each(appStreams, function(name, stream) {
				streams[stream.app + '/' + name] = stream;
			});
		});
		return streams;
	}

	function getAppStreams(app) {
		var appName = app.children("name").text();
		if(appName === undefined)
			return {};
		return getStreamsFromApp(appName, app); 
	}

	function getStreamsFromApp(appName, app) {
		var streams = {};
		app.find("stream").each(function(idx, stream) {
			var streamInfo = parseStreamInfo(appName, stream);
			if(streamInfo === "")
				return true;
			streams[streamInfo.name] = streamInfo;
		});
		return streams;
	}

	function parseStreamInfo(appName, stream) {
		var streamObject = $(stream);
		if(streamObject.find("publishing").length === 0)
			return '';
		var name = streamObject.find("name").text();
		var time = streamObject.find("time").text();
		var slotNode = streamObject.find("slot");
		var slotData = (slotNode.length > 0) ?
			{idx: slotNode.text(), isSelected: slotNode.attr('selected'), isOnAir: slotNode.attr('onair')} :
			{idx: undefined, isSelected: false, isOnAir: false}
		return {
			"time": time,
			"name": name,
			"app": appName,
			"slot": slotData.idx,
			"isSelected": slotData.isSelected,
			"isOnAir": slotData.isOnAir
		}
	}

	function updateSlotsState(streams) {
		jQuery.each(streams, function(streamURL, stream) {
			var container = getPlayerContainerByURL(streamURL);
			if(container.length === 0)
				return;
			if(stream.isSelected)
				container.addClass('selected');
			else
				container.removeClass('selected');
			if(stream.isOnAir)
				container.addClass('onair');
			else
				container.removeClass('onair');
			if(stream.isRedirected)
				container.addClass('shared');
			else
				container.removeClass('shared');
		});
	}

	function closeInactivePlayers(newStreams) {
		jQuery.each(Slots, function(idx, slotData) {
			if(slotData == undefined)
				return true;
			var streamURL = slotData.stream;
			if(streamURL == undefined)
				return true;
			if(newStreams[streamURL] != undefined)
				return true;
			stopAndRemovePlayerFromSlot(idx);
			delete Slots[idx].stream;
		});
	}

	function getAllPlayerContainers() {
		return ComponentContainer.children(".player-container");
	}

	function openPlayersForNewStreams(newStreams) {
		jQuery.each(newStreams, function(streamURL, stream) {
			if(!shouldShowStream(stream))
				return;
			if(isActive(streamURL))
				return true;
			var selectedIdx = getNewStreamContainerIdx(stream);
			if(selectedIdx < 0) {
				setOutOfStreamSlotsIndicator(stream.zone);
				return true;
			} else
				resetOutOfStreamSlotsIndicator(stream.zone);
			if(Slots[selectedIdx])
				Slots[selectedIdx].stream = streamURL;
			else
				Slots[selectedIdx] = {"stream" : streamURL};
			var container = getContainerByIdx(selectedIdx);
			if(container.length === 0)
				return true;
			stopBackgroundPlayer({container: container, slotIdx: selectedIdx});
			createAndStartPlayer({"container": container, "stream": stream});
		});
	}

	function isActive(streamURL) {
		var streams = $.grep(Slots, function(slotData) {
			return slotData && slotData.stream == streamURL;
		});
		return streams.length > 0;
	}

	function getContainerByIdx(idx) {
		return $(getAllPlayerContainers()[idx - FirstPageIdx]);
	}

	function stopAndRemovePlayerFromSlot(idx) {
		var slot = Slots[idx];
		var streamURL = slot.stream;
		var container = getPlayerContainerByURL(streamURL);
		if(container.length === 0)
			return;
		removePlayer({container: container, player: Players[streamURL]});
		clearContainer(container);
		delete Players[streamURL];
		var data = {"container": container, "stream": {"name": ""}};
		setStreamTitle(data);
		setStreamControls(data);
		var zoneInfo = config.Zones[slot.zone];
		if(zoneInfo && zoneInfo.BackgroundStream)
				startBackgroundPlayer({slotIdx: idx, container: container, stream: zoneInfo.BackgroundStream});
	}

	function clearContainer(container) {
		container.removeData("bcme-msp-stream-url");
		container.removeClass('selected');
		container.removeClass('onair');
		container.removeClass('shared');
	}

	function startBackgroundPlayer(params) {
		var player = createPlayer(params);
		BackgroundPlayers[params.slotIdx] = player;
		player.play();
	}

	function stopBackgroundPlayer(params) {
		var idx = params.slotIdx;
		removePlayer({container: params.container, player: BackgroundPlayers[idx]});
		delete BackgroundPlayers[idx];	
	}

	function getPlayerContainerByURL(streamURL) {
		return ComponentContainer
			.find(".player-container")
			.filter(function() { return $(this).data("bcme-msp-stream-url") == streamURL })
			.first();
	}

	function removePlayer(params) {
		try {
			params.player.remove();
		} catch(e) {
			console.log("Can't remove player - removing it's element");
			params.container.find("div:first-child").empty();
		}
	}

	function setOutOfStreamSlotsIndicator(zone) { }

	function resetOutOfStreamSlotsIndicator(zone) { }

	function createAndStartPlayer(params) {
		var player = createPlayer(params);
		if(!player) {
			console.log("Failed to create player for stream " + params.stream.fullURL);
			return;
		}
		var streamURL = params.stream.fullURL;
		Players[streamURL] = player;
		params.container.data("bcme-msp-stream-url", streamURL);
		setStreamTitle(params);
		setStreamControls(params);
		player.play();
	}

	function createPlayer(params) {
		var container = params.container;
		var playerElement = container.find("div:first-child");
		var playerElementId = playerElement.prop("id");
		var stream = params.stream;
		var player = jwplayer(playerElementId).setup({
			flashplayer: "player.swf",
			playlist: [{
				file: stream.name,
				type: "rtmp"
			}],
			rtmp: {
				bufferlength: 0.1
			},
			width: playerElement.width(),
			height: playerElement.height(),
			streamer: _auth_protected_url(stream),
			controls: false,
			mute: true
		});
		return player;
	}

	function _auth_protected_url(stream) {
		var streamConfig = config.Servers[stream.server] ? 
			config.Servers[stream.server].Apps[stream.app] : undefined;
		return (streamConfig && streamConfig.NoAuth) ?
				"rtmp://" + stream.url :
				"rtmp://" + stream.url + "?authmod=token&token=" + Token;
	}

	function setStreamTitle(params) {
		var titleContainerLink = params.container.find(".stream-title").find('a');
		var stream = params.stream;
		if(stream.name === "") {
			titleContainerLink.prop('href', '#');
			return;
		}
		titleContainerLink.prop('href', makeFullscreenURLLink(stream));
	}

	function setStreamControls(params) {
		var infoContainer = params.container.find(".stream-info");
		var stream = params.stream;
		if(stream.name === "") {
			infoContainer.empty();
			return;
		}
		var appConfig = config.Servers[stream.server].Apps[stream.app];
		if(!appConfig)
			return;
		var sharingConfig = config.Client.Sharing;
		if(!sharingConfig)
			return;
		var shareData = {};
		var originalStream;
		if(appConfig.Shareable)
			shareData = {operation: shareStream, label: '+ ' + sharingConfig.Label, stream: stream}
		else if(sharingConfig.CommonApp === stream.app && (originalStream = getOriginalStream(stream)))
			shareData = {operation: unShareStream, label: '- ' + sharingConfig.Label, stream: originalStream}
		else
			return;
		var shareElement = $('<a href="#">' + shareData.label + '</a>');
		shareElement.on('click', shareData, shareData.operation);
		return infoContainer.append(shareElement);
	}

	function getOriginalStream(stream) {
		var originalStream = undefined;
		$.each(Streams, function(url, testStream) {
			if(testStream.isRedirected && (testStream.name === (stream.name + '@' + stream.app))) {
				originalStream = testStream;
				return false;
			}
		});
		return originalStream;
	}

	function shareStream(evt) {
		var data = evt.data;
		var stream = data.stream;
		var sharingConfig = config.Client.Sharing;
		if(sharingConfig == undefined)
			return;
		var commonApp = sharingConfig.CommonApp;
		var serverConfig = config.Servers[stream.server];
		if(serverConfig == undefined || serverConfig.ControlURL == undefined)
			return;
		var controlUrl = serverConfig.ControlURL;
		var streamName = stream.name;
		var streamApp = stream.app;
		$.get(controlUrl + '/redirect/publisher?app=' + streamApp + '&name=' + streamName + '&newname=' + streamName + "@" + commonApp);
	}

	function unShareStream(evt) {
		var data = evt.data;
		var stream = data.stream;
		var serverConfig = config.Servers[stream.server];
		if(serverConfig == undefined || serverConfig.ControlURL == undefined)
			return;
		var controlUrl = serverConfig.ControlURL;
		var streamName = stream.name;
		var streamApp = stream.app;
		$.get(controlUrl + '/redirect/publisher?app=' + streamApp + '&name=' + streamName + '&newname=' + streamName.replace(/\@.+$/, ''));
	}

	function makeFullscreenURLLink(stream) {
		var appConfig = config.Servers[stream.server].Apps[stream.app];
		var nameMap = appConfig.LowDelayStreams;
		return (nameMap != undefined && nameMap[stream.name] != undefined) ?
			nameMap[stream.name] : _makeDefaultFullscreenURL(stream);
	}

	function makeFullStreamName(stream) {
		var appConfig = config.Servers[stream.server].Apps[stream.app];
		if(!appConfig)
			return stream.name;
		var zone = config.Zones[appConfig.Zone];
		if(zone && zone.Slots && appConfig.Streams) {
			var names = $.grep(zone.Slots, function(slotData) {
				return slotData.Pos == appConfig.Streams[stream.name];
			});
			if(names.length > 0)
				return names[0].Name;
		}
		return appConfig.Prefix ?
			appConfig.Prefix + "-" + stream.name : stream.name;
	}

	function _makeDefaultFullscreenURL(stream) {
		var streamURL = stream.fullURL;
		return config.Client.useExternalPlayer ?
			"rtmp://" + streamURL + " tcurl=" + _auth_protected_url(stream) :
			"?" + $.param({"mode" : "single",
					"server" : stream.server,
					"app" : stream.app,
					"name" : stream.name,
					"url" : stream.url
				});
	}

	function getNewStreamContainerIdx(stream) {
		var explicitSlotIdx = getStreamExplicitSlotIdx(stream);
		if(explicitSlotIdx != undefined)
			return explicitSlotIdx - 1;
		var resIdx = -1;
		for(var i=0;i<TotalLastIdx;i++) {
			var obj = Slots[i];
			if(!zonesAreSame(obj, stream))
				continue;
			if(!obj || (obj.stream == undefined && obj.streamId == undefined)) {
				resIdx = i;
				break;
			}
		}
		return resIdx;
	}

	function getStreamExplicitSlotIdx(stream) {
		return stream.slot;
	}

	function zonesAreSame(slotObj, streamObj) {
		if(slotObj == undefined)
			return streamObj.zone == undefined;
		return slotObj.zone === streamObj.zone;
	}

	$(function() {
		try {
			Init();
		} catch(e) {
			console.log(e);
		}
	});
});
