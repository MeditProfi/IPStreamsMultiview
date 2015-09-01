requirejs.config({
	baseUrl: "js/lib",
	paths: {
		app: "../bcmeMultiStreamPlayer",
                jquery: "../lib/jquery-2.0.3.min"
	},
	shim: {
		"jquery.cookie" : ["jquery"],
		"purl" : ["jquery"]
	}
});

requirejs(["app/main"])
